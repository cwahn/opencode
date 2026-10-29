import { expect } from "bun:test"
import { Clock, Effect, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"
import { OauthCallbackListener } from "../src/oauth/callback-listener"
import { it } from "./lib/effect"

const policy: OauthCallbackListener.Policy = {
  port: 101,
  fallbackPort: 102,
  attempts: 10,
  retryDelay: 200,
  exhausted: "Both callback ports are busy",
}
const busy = () => Object.assign(new Error("busy"), { code: "EADDRINUSE" })

it.effect("returns the actual bound port without cancellation on success", () =>
  Effect.gen(function* () {
    const ports: number[] = []
    const port = yield* OauthCallbackListener.bind(
      {
        bind: (port) =>
          Effect.sync(() => {
            ports.push(port)
            return 49152
          }),
        cancel: () => Effect.die("must not cancel a successful bind"),
      },
      { ...policy, port: 0 },
    )
    expect(port).toBe(49152)
    expect(ports).toEqual([0])
  }),
)

it.effect("cancels the primary owner once and waits before rebinding its released address", () =>
  Effect.gen(function* () {
    const owned = new Set([policy.port])
    const events: string[] = []
    const fiber = yield* OauthCallbackListener.bind(
      {
        bind: (port) =>
          Effect.suspend(() => {
            events.push(`bind:${port}`)
            return owned.has(port) ? Effect.fail(busy()) : Effect.succeed(port)
          }),
        cancel: (port) =>
          Effect.sync(() => {
            expect(owned.has(port)).toBe(true)
            owned.delete(port)
            events.push(`cancel:${port}`)
          }),
      },
      policy,
    ).pipe(Effect.forkChild({ startImmediately: true }))
    expect(events).toEqual(["bind:101", "cancel:101"])
    yield* TestClock.adjust(199)
    expect(events).toEqual(["bind:101", "cancel:101"])
    yield* TestClock.adjust(1)
    expect(yield* Fiber.join(fiber)).toBe(101)
    expect(events).toEqual(["bind:101", "cancel:101", "bind:101"])
  }),
)

it.effect("retries only busy addresses, ignores cancellation failure and falls back after ten primary attempts", () =>
  Effect.gen(function* () {
    const attempts: { port: number; time: number }[] = []
    const cancellations: number[] = []
    const fiber = yield* OauthCallbackListener.bind(
      {
        bind: (port) =>
          Effect.gen(function* () {
            attempts.push({ port, time: yield* Clock.currentTimeMillis })
            return port === policy.port ? yield* Effect.fail(busy()) : port
          }),
        cancel: (port) => Effect.sync(() => cancellations.push(port)).pipe(Effect.andThen(Effect.fail("refused"))),
      },
      policy,
    ).pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust(1800)
    expect(yield* Fiber.join(fiber)).toBe(102)
    expect(cancellations).toEqual([101])
    expect(attempts).toEqual([
      ...Array.from({ length: 10 }, (_, index) => ({ port: 101, time: index * 200 })),
      { port: 102, time: 1800 },
    ])
  }),
)

it.effect("reports exhaustion after ten attempts on each port without cancelling the fallback", () =>
  Effect.gen(function* () {
    const ports: number[] = []
    const cancellations: number[] = []
    const fiber = yield* OauthCallbackListener.bind(
      {
        bind: (port) => Effect.sync(() => ports.push(port)).pipe(Effect.andThen(Effect.fail(busy()))),
        cancel: (port) => Effect.sync(() => cancellations.push(port)),
      },
      policy,
    ).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust(3600)
    const result = yield* Fiber.join(fiber)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toBe(policy.exhausted)
    expect(ports).toEqual([...Array(10).fill(101), ...Array(10).fill(102)])
    expect(cancellations).toEqual([101])
  }),
)

for (const failingPort of [101, 102])
  it.effect(`propagates non-address errors immediately on port ${failingPort}`, () =>
    Effect.gen(function* () {
      const ports: number[] = []
      const error = Object.assign(new Error("permission denied"), { code: "EACCES" })
      const fiber = yield* OauthCallbackListener.bind(
        {
          bind: (port) =>
            Effect.suspend(() => {
              ports.push(port)
              return Effect.fail(port === failingPort ? error : busy())
            }),
          cancel: () => Effect.void,
        },
        policy,
      ).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(failingPort === 101 ? 0 : 1800)
      const result = yield* Fiber.join(fiber)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(error)
      expect(ports).toEqual(failingPort === 101 ? [101] : [...Array(10).fill(101), 102])
    }),
  )

it.effect("interruption releases scoped ownership and stops bind retries", () =>
  Effect.gen(function* () {
    const events: string[] = []
    const fiber = yield* Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push("release")
        }),
      )
      yield* OauthCallbackListener.bind(
        {
          bind: () =>
            Effect.sync(() => {
              events.push("bind")
            }).pipe(Effect.andThen(Effect.fail(busy()))),
          cancel: () =>
            Effect.sync(() => {
              events.push("cancel")
            }),
        },
        policy,
      )
    }).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }))
    yield* Fiber.interrupt(fiber)
    yield* TestClock.adjust(4000)
    expect(events).toEqual(["bind", "cancel", "release"])
  }),
)

it.live("serves callbacks on an OS-assigned port", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const port = yield* OauthCallbackListener.native.listen(
        (request, response) => {
          response.writeHead(request.url === "/auth/callback?code=owned" ? 200 : 404).end("callback")
        },
        { ...policy, port: 0, fallbackPort: 0 },
      )
      expect(port).toBeGreaterThan(0)
      const response = yield* Effect.promise(() =>
        fetch(`http://localhost:${port}/auth/callback?code=owned`, {
          headers: { connection: "close" },
        }),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toBe("callback")
    }).pipe(Effect.scoped)
  }),
)
