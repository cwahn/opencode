import { Effect } from "effect"
import { S3mini, S3ServiceError, type ListObject } from "s3mini"
import { Failed, NotFound, WrongKind, type DirEntry, type FileInfo, type Files } from "./files.js"

export interface Options {
  readonly endpoint: string
  readonly bucket: string
  readonly prefix?: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly region?: string
}

export const ROOT = "/workspace"

export function make(options: Options): Files & {
  readonly walk: (
    path: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly path: string; readonly info: FileInfo }>, NotFound | WrongKind | Failed>
  readonly fromUri: (uri: string) => string | undefined
} {
  const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "")
  if (!safe(prefix)) throw new Error("Invalid S3 prefix")
  const base = prefix ? `${prefix}/` : ""
  const relative = (value: string) => {
    if (value !== ROOT && !value.startsWith(`${ROOT}/`)) throw new Failed({ path: value, cause: "Outside S3 root" })
    const result = value.slice(ROOT.length).replace(/^\/+|\/+$/g, "")
    if (!safe(result)) throw new Failed({ path: value, cause: "Invalid S3 path" })
    return result
  }
  const key = (value: string) => `${base}${relative(value)}`
  const virtual = (value: string) => {
    if (!value.startsWith(base)) return undefined
    const result = value.slice(base.length).replace(/\/$/, "")
    if (!safe(result)) return undefined
    return result ? `${ROOT}/${result}` : ROOT
  }
  const client = (signal: AbortSignal, capture?: (headers: Headers) => void) =>
    new S3mini({
      endpoint: options.endpoint,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region,
      requestAbortTimeout: 30_000,
      // Supplying fetch also disables Bun's native transport, which bypasses cancellation and HEAD capture.
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const response = await fetch(input, {
            ...init,
            signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
          })
          if (init?.method === "HEAD") capture?.(response.headers)
          return response
        },
        { preconnect: fetch.preconnect },
      ),
    })
  const all = async (s3: S3mini, start: string) => {
    const objects: ListObject[] = []
    let token: string | undefined
    do {
      // s3mini calls the request path "delimiter"; '/' lists recursively unless a query delimiter is supplied.
      const page = await s3.listObjectsPaged("/", start, 1000, token)
      if (!page || !page.objects) throw new Error("S3 bucket does not exist")
      objects.push(...page.objects.filter((entry) => entry.Key.startsWith(start) && virtual(entry.Key) !== undefined))
      token = page.nextContinuationToken
    } while (token)
    return objects
  }
  const head = async (signal: AbortSignal, value: string): Promise<FileInfo | undefined> => {
    const metadata = { headers: new Headers() }
    const size = await client(signal, (headers) => (metadata.headers = headers))
      .getContentLength(value)
      .catch((error: unknown) => {
        if (missing(error)) return undefined
        throw error
      })
    if (size === undefined) return undefined
    return { type: "file", size, mtimeMs: modified(metadata.headers.get("last-modified")) }
  }
  const stat = async (s3: S3mini, signal: AbortSignal, value: string): Promise<FileInfo> => {
    const target = key(value)
    if (relative(value) === "") return directory()
    const file = await head(signal, target)
    if (file) return file
    const marker = await head(signal, `${target}/`)
    if (marker) return { ...marker, type: "directory", size: 0 }
    if ((await all(s3, `${target}/`)).length) return directory()
    throw new NotFound({ path: value })
  }
  const optional = (s3: S3mini, signal: AbortSignal, value: string) =>
    stat(s3, signal, value).catch((error: unknown) => {
      if (error instanceof NotFound) return undefined
      throw error
    })
  const mkdir = async (s3: S3mini, signal: AbortSignal, value: string) => {
    const parts = relative(value).split("/").filter(Boolean)
    for (const index of parts.keys()) {
      const current = `${ROOT}/${parts.slice(0, index + 1).join("/")}`
      const info = await optional(s3, signal, current)
      if (info && info.type !== "directory") throw new Error(`Not a directory: ${current}`)
      if (!info) await s3.putObject(`${key(current)}/`, new Uint8Array())
    }
  }
  const run = <A>(value: string, action: (s3: S3mini, signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: (signal) => {
        relative(value)
        return action(client(signal), signal)
      },
      catch: (cause) =>
        cause instanceof NotFound || cause instanceof WrongKind || cause instanceof Failed
          ? cause
          : new Failed({ path: value, cause }),
    })
  const onlyFailed = <A>(effect: Effect.Effect<A, NotFound | WrongKind | Failed>, value: string) =>
    effect.pipe(Effect.mapError((cause) => (cause instanceof Failed ? cause : new Failed({ path: value, cause }))))

  return {
    fromUri: (uri) => {
      // Parse the raw path before decoding: URL would silently normalize traversal segments.
      const match = /^s3:\/\/([^/?#]+)(?:\/([^?#]*))?$/.exec(uri)
      if (!match || match[1] !== options.bucket) return undefined
      const decoded = decode(match[2] ?? "")
      if (decoded === undefined) return undefined
      const target = decoded.replace(/\/$/, "")
      if (!safe(target)) return undefined
      if (target === prefix) return ROOT
      return virtual(target)
    },
    stat: (value) =>
      run(value, (s3, signal) => stat(s3, signal, value)).pipe(
        Effect.mapError((cause) => (cause instanceof WrongKind ? new Failed({ path: value, cause }) : cause)),
      ),
    read: (value, range) =>
      run(value, async (s3, signal) => {
        const info = await stat(s3, signal, value)
        if (info.type !== "file") throw new WrongKind({ path: value, actual: info.type })
        if (
          range &&
          (!Number.isSafeInteger(range.offset) ||
            !Number.isSafeInteger(range.length) ||
            range.offset < 0 ||
            range.length < 0)
        ) {
          throw new Error("Invalid byte range")
        }
        if (info.size === 0 || (range && (range.length === 0 || range.offset >= info.size))) {
          return { info, bytes: new Uint8Array() }
        }
        const response = await s3.getObjectRaw(
          key(value),
          range === undefined,
          range?.offset,
          range ? range.offset + Math.min(range.length, info.size - range.offset) : undefined,
        )
        if (range) {
          const length = Math.min(range.length, info.size - range.offset)
          const expected = `bytes ${range.offset}-${range.offset + length - 1}/${info.size}`
          if (response.status !== 206 || response.headers.get("content-range") !== expected) {
            await response.body?.cancel()
            throw new Error("S3 returned an invalid range response")
          }
          return { info, bytes: await bounded(response, length) }
        }
        return { info, bytes: new Uint8Array(await response.arrayBuffer()) }
      }),
    write: (value, bytes) =>
      onlyFailed(
        run(value, async (s3, signal) => {
          const info = await optional(s3, signal, value)
          if (info?.type === "directory") throw new Error(`Is a directory: ${value}`)
          await mkdir(s3, signal, parent(value))
          await s3.putObject(key(value), bytes)
        }),
        value,
      ),
    mkdir: (value) =>
      onlyFailed(
        run(value, (s3, signal) => mkdir(s3, signal, value)),
        value,
      ),
    list: (value) =>
      run(value, async (s3, signal) => {
        const info = await stat(s3, signal, value)
        if (info.type !== "directory") throw new WrongKind({ path: value, actual: info.type })
        const start = value.replace(/\/+$/, "") === ROOT ? base : `${key(value)}/`
        const entries = new Map<string, DirEntry>()
        for (const object of await all(s3, start)) {
          const rest = object.Key.slice(start.length)
          if (!rest) continue
          const name = rest.slice(0, rest.indexOf("/") === -1 ? rest.length : rest.indexOf("/"))
          entries.set(name, { name, type: rest.includes("/") ? "directory" : "file" })
        }
        return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
      }),
    walk: (value) =>
      run(value, async (s3, signal) => {
        const info = await stat(s3, signal, value)
        if (info.type !== "directory") throw new WrongKind({ path: value, actual: info.type })
        const start = value.replace(/\/+$/, "") === ROOT ? base : `${key(value)}/`
        return (await all(s3, start))
          .filter((entry) => !entry.Key.endsWith("/"))
          .flatMap((entry) => {
            const path = virtual(entry.Key)
            return path === undefined
              ? []
              : [{ path, info: { type: "file" as const, size: entry.Size, mtimeMs: entry.LastModified.getTime() } }]
          })
          .sort((a, b) => a.path.localeCompare(b.path))
      }),
    remove: (value) =>
      onlyFailed(
        run(value, async (s3) => {
          const target = key(value)
          const objects = await all(s3, relative(value) ? `${target}/` : base)
          // Never delete the bucket itself, including when the virtual root has an empty prefix.
          const keys = [...objects.map((entry) => entry.Key), ...(relative(value) ? [target] : [])]
          for (const entry of keys) {
            if (!(await s3.deleteObject(entry))) throw new Error(`S3 delete failed: ${entry}`)
          }
        }),
        value,
      ),
    move: (from, to) =>
      run(from, async (s3, signal) => {
        relative(to)
        const source = await stat(s3, signal, from)
        if (!relative(from)) throw new Error("Cannot move S3 root")
        const existing = await optional(s3, signal, to)
        const destination =
          existing?.type === "directory" ? `${to.replace(/\/+$/, "")}/${relative(from).split("/").at(-1)}` : to
        const origin = key(from)
        const target = key(destination)
        if (origin === target) return
        if (source.type === "directory" && target.startsWith(`${origin}/`))
          throw new Error("Cannot move directory into itself")
        const replaced = await optional(s3, signal, destination)
        if (replaced && (replaced.type !== source.type || replaced.type === "directory"))
          throw new Error("Destination exists")
        const container = await stat(s3, signal, parent(destination))
        if (container.type !== "directory") throw new Error("Destination parent is not a directory")
        const keys = source.type === "directory" ? (await all(s3, `${origin}/`)).map((entry) => entry.Key) : [origin]
        // Copy every object before deleting any source; moves are deliberately non-atomic.
        for (const entry of keys) await s3.copyObject(entry, `${target}${entry.slice(origin.length)}`)
        for (const entry of keys) {
          if (!(await s3.deleteObject(entry))) throw new Error(`S3 delete failed: ${entry}`)
        }
      }).pipe(Effect.mapError((cause) => (cause instanceof WrongKind ? new Failed({ path: from, cause }) : cause))),
  }
}

function safe(value: string) {
  return (
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "." || part === ".." || (part === "" && value !== ""))
  )
}

function decode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function missing(error: unknown): boolean {
  return error instanceof S3ServiceError
    ? error.status === 404
    : error instanceof Error && error.cause !== undefined && missing(error.cause)
}

function directory(): FileInfo {
  return { type: "directory", size: 0, mtimeMs: 0 }
}

function modified(value: string | null) {
  return value === null ? 0 : Date.parse(value)
}

function parent(value: string) {
  return value.replace(/\/+$/, "").slice(0, value.replace(/\/+$/, "").lastIndexOf("/"))
}

async function bounded(response: Response, length: number) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("S3 returned no range body")
  const bytes = new Uint8Array(length)
  let offset = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (offset + chunk.value.length > length) throw new Error("S3 range body exceeds requested length")
      bytes.set(chunk.value, offset)
      offset += chunk.value.length
    }
    if (offset !== length) throw new Error("S3 range body is shorter than requested length")
    return bytes
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

export * as S3Files from "./s3.js"
