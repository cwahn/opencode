export * as OauthCallbackListener from "./callback-listener.js"

import { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, Effect, Layer, Scope } from "effect"
import type { RequestListener } from "node:http"

export type Policy = {
  readonly port: number
  readonly fallbackPort: number
  readonly attempts: number
  readonly retryDelay: number
  readonly exhausted: string
}

export type Binding = {
  readonly bind: (port: number) => Effect.Effect<number, Error>
  // The embedder owns which addresses may be cancelled. Tests must supply an
  // implementation restricted to their own listeners, never the host defaults.
  readonly cancel: (port: number) => Effect.Effect<unknown, unknown>
}

export interface Interface {
  readonly listen: (handler: RequestListener, policy: Policy) => Effect.Effect<number, Error, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OauthCallbackListener") {}

export const bind = Effect.fn("OauthCallbackListener.bind")(function* (binding: Binding, policy: Policy) {
  const retry = (port: number, attempts: number): Effect.Effect<number, Error> =>
    binding.bind(port).pipe(
      Effect.catchIf(
        (error) => addressInUse(error) && attempts > 1,
        () => Effect.sleep(policy.retryDelay).pipe(Effect.andThen(retry(port, attempts - 1))),
      ),
    )
  return yield* binding.bind(policy.port).pipe(
    Effect.catchIf(addressInUse, () =>
      binding.cancel(policy.port).pipe(
        Effect.ignore,
        Effect.andThen(Effect.sleep(policy.retryDelay)),
        Effect.andThen(retry(policy.port, policy.attempts - 1)),
        Effect.catchIf(addressInUse, () =>
          retry(policy.fallbackPort, policy.attempts).pipe(
            Effect.catchIf(addressInUse, () => Effect.fail(new Error(policy.exhausted))),
          ),
        ),
      ),
    ),
  )
})

export const native: Interface = {
  listen: Effect.fn("OauthCallbackListener.listen")(function* (handler, policy) {
    // Keep node:http lazy for runtimes without loopback sockets (workerd).
    const { createServer } = yield* Effect.promise(() => import("node:http"))
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => createServer(handler)),
      (server) =>
        Effect.callback<void>((resume) => {
          // The callback can settle its attempt before its response is flushed.
          // Close gracefully so the browser still receives the result page.
          server.close(() => resume(Effect.void))
        }),
    )
    return yield* bind(
      {
        bind: (port) =>
          Effect.callback<number, Error>((resume) => {
            const onError = (error: Error) => resume(Effect.fail(error))
            server.once("error", onError)
            server.listen(port, "localhost", () => {
              server.off("error", onError)
              const address = server.address()
              resume(
                address && typeof address !== "string"
                  ? Effect.succeed(address.port)
                  : Effect.fail(new Error("OAuth callback listener has no TCP address")),
              )
            })
            return Effect.sync(() => server.off("error", onError))
          }),
        cancel: (port) =>
          Effect.tryPromise({
            try: (signal) =>
              fetch(`http://localhost:${port}/cancel`, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
              }),
            catch: (cause) => cause,
          }),
      },
      policy,
    )
  }),
}

export const node = LayerNode.make({ service: Service, layer: Layer.succeed(Service, native), deps: [] })

function addressInUse(error: Error) {
  return "code" in error && error.code === "EADDRINUSE"
}
