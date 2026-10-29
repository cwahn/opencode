import { expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { Integration } from "../src/integration"
import { OauthCallbackListener } from "../src/oauth/callback-listener"
import { Plugin } from "../src/plugin"
import { PluginHost } from "../src/plugin/host"
import { OpenAIPlugin } from "../src/plugin/provider/openai"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const connect = Effect.fn(function* (released?: Deferred.Deferred<void>) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpenAIPlugin.effect(host).pipe(
    Effect.provideService(OauthCallbackListener.Service, {
      // This wrapper owns only port 0 listeners. Native cancellation cannot be
      // reached: each bind is assigned a fresh address by the operating system.
      listen: (handler, policy) =>
        Effect.gen(function* () {
          // Registered first, so this observes completion of the native finalizer.
          if (released) yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined))
          return yield* OauthCallbackListener.native.listen(handler, { ...policy, port: 0, fallbackPort: 0 })
        }),
    }),
  )
  const integration = yield* Integration.Service
  return yield* integration.oauth.connect({
    integrationID: Integration.ID.make("openai"),
    methodID: Integration.MethodID.make("chatgpt-browser"),
  })
})

for (const input of [
  { query: "", message: "Missing authorization code" },
  { query: "?code=owned&state=wrong", message: "Invalid OAuth state" },
  { query: "?error=access_denied&error_description=Declined", message: "Declined" },
])
  it.live(`OpenAI callback rejects ${input.message} on its own ephemeral listener`, () =>
    Effect.gen(function* () {
      const attempt = yield* connect()
      const authorize = new URL(attempt.url)
      const redirect = authorize.searchParams.get("redirect_uri")
      expect(redirect).not.toBeNull()
      if (!redirect) return yield* Effect.die("Missing callback redirect")
      expect(new URL(redirect).port).not.toBe("0")
      expect(authorize.searchParams.get("state")).toBeTruthy()
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")

      const missing = yield* Effect.promise(() =>
        fetch(new URL("/unrelated", redirect), {
          headers: { connection: "close" },
        }),
      )
      expect(missing.status).toBe(404)
      expect(yield* Effect.promise(() => missing.text())).toBe("Not found")

      const response = yield* Effect.promise(() =>
        fetch(`${redirect}${input.query}`, {
          headers: { connection: "close" },
        }),
      )
      expect(response.status).toBe(400)
      expect(response.headers.get("content-type")).toBe("text/html")
      expect(yield* Effect.promise(() => response.text())).toContain(input.message)
    }),
  )

it.live("cancelling an OpenAI attempt releases only its own ephemeral callback listener", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>()
    const attempt = yield* connect(released)
    const integration = yield* Integration.Service
    yield* integration.oauth.cancel({ integrationID: Integration.ID.make("openai"), attemptID: attempt.attemptID })
    expect(yield* Deferred.isDone(released)).toBe(true)
  }),
)
