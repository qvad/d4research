import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { readOllamaUsageLimits } from "./ollamaUsageLimits.ts";

const read = (status: number, body: unknown) => {
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  return readOllamaUsageLimits("key-1").pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
      }),
    ),
    Effect.map((limits) => ({ limits, requests })),
  );
};

it.layer(NodeCrypto.layer)("Ollama usage limits", (it) => {
  it.effect("reports included credits as the share of the allowance already spent", () =>
    Effect.gen(function* () {
      const { limits, requests } = yield* read(200, {
        included: {
          balance_usd: 72.5,
          allowance_usd: 100,
          period: { from: "2026-09-15T09:30:00Z", until: "2026-10-15T09:30:00Z" },
        },
        purchased: { balance_usd: 25 },
      });
      assert.deepStrictEqual(requests, [
        { url: "https://ollama.com/api/balance", authorization: "Bearer key-1" },
      ]);
      assert.isUndefined(limits.unavailable);
      assert.match(limits.credentialFingerprint ?? "", /^[0-9a-f]{64}$/);
      assert.deepStrictEqual(limits.windows, [
        {
          id: "ollama_included",
          kind: "monthly",
          label: "Ollama · Included credits",
          usedPercent: 27.5,
          resetsAt: "2026-10-15T09:30:00.000Z",
          windowDurationMins: 30 * 24 * 60,
        },
      ]);
    }),
  );

  it.effect("reports the session and weekly limits of a legacy plan", () =>
    Effect.gen(function* () {
      const { limits } = yield* read(200, {
        included: {
          session: { remaining_percent: 75, resets_at: "2026-10-01T07:00:00Z" },
          weekly: { remaining_percent: 40, resets_at: "2026-10-05T00:00:00Z" },
        },
        purchased: { balance_usd: 25 },
      });
      assert.deepStrictEqual(limits.windows, [
        {
          id: "ollama_session",
          kind: "session",
          label: "Ollama · Session",
          usedPercent: 25,
          resetsAt: "2026-10-01T07:00:00.000Z",
        },
        {
          id: "ollama_weekly",
          kind: "weekly",
          label: "Ollama · Weekly",
          windowDurationMins: 7 * 24 * 60,
          usedPercent: 60,
          resetsAt: "2026-10-05T00:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("reports no window for a plan without included credits", () =>
    Effect.gen(function* () {
      const { limits } = yield* read(200, {
        included: {
          balance_usd: 0,
          allowance_usd: 0,
          period: { from: "2026-09-15T09:30:00Z", until: "2026-10-15T09:30:00Z" },
        },
        purchased: { balance_usd: 25 },
      });
      assert.deepStrictEqual(limits.windows, []);
      assert.isUndefined(limits.unavailable);
    }),
  );

  it.effect("names a rejected key and treats every other failure as a failed probe", () =>
    Effect.gen(function* () {
      const rejected = yield* read(401, { error: "unauthorized" });
      assert.deepStrictEqual(rejected.limits.unavailable, {
        reason: "probeFailed",
        message: "Ollama rejected OLLAMA_API_KEY.",
      });
      for (const [status, body] of [
        [429, { error: "too many requests" }],
        [200, { included: { session: "soon" } }],
      ] as const) {
        const failed = yield* read(status, body);
        assert.deepStrictEqual(failed.limits.unavailable, {
          reason: "probeFailed",
          message: "Could not read Ollama cloud usage.",
        });
        assert.deepStrictEqual(failed.limits.windows, []);
      }
    }),
  );
});
