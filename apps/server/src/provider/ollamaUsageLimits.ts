import type { ServerProviderUsageWindow } from "@d4research/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@d4research/provider-core/server/usageLimits";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

// https://docs.ollama.com/api/balance. The local daemon does not proxy this endpoint, and the
// cloud accepts only an API key for it, so a signed-in daemon alone cannot report limits.
const OLLAMA_BALANCE_URL = "https://ollama.com/api/balance";

const LegacyLimit = Schema.Struct({
  remaining_percent: Schema.Finite,
  resets_at: Schema.DateTimeUtcFromString,
});
const IncludedBalance = Schema.Union([
  Schema.Struct({
    balance_usd: Schema.Finite,
    allowance_usd: Schema.Finite,
    period: Schema.Struct({
      from: Schema.DateTimeUtcFromString,
      until: Schema.DateTimeUtcFromString,
    }),
  }),
  // Legacy plans report a session and a weekly limit instead of credits.
  Schema.Struct({ session: LegacyLimit, weekly: LegacyLimit }),
]);
const BalanceResponse = Schema.Struct({ included: IncludedBalance });

function ollamaBalanceWindows(included: typeof IncludedBalance.Type): ServerProviderUsageWindow[] {
  if ("session" in included) {
    return [
      {
        id: "ollama_session",
        kind: "session",
        label: "Ollama · Session",
        usedPercent: clampPercent(100 - included.session.remaining_percent),
        resetsAt: DateTime.formatIso(included.session.resets_at),
      },
      {
        id: "ollama_weekly",
        kind: "weekly",
        label: "Ollama · Weekly",
        windowDurationMins: 7 * 24 * 60,
        usedPercent: clampPercent(100 - included.weekly.remaining_percent),
        resetsAt: DateTime.formatIso(included.weekly.resets_at),
      },
    ];
  }
  // A plan without included credits has no allowance to measure against.
  if (included.allowance_usd <= 0) return [];
  const periodMins = Math.round(
    (DateTime.toEpochMillis(included.period.until) - DateTime.toEpochMillis(included.period.from)) /
      60_000,
  );
  return [
    {
      id: "ollama_included",
      kind: "monthly",
      label: "Ollama · Included credits",
      usedPercent: clampPercent(100 - (included.balance_usd * 100) / included.allowance_usd),
      resetsAt: DateTime.formatIso(included.period.until),
      ...(periodMins > 0 ? { windowDurationMins: periodMins } : {}),
    },
  ];
}

export const readOllamaUsageLimits = Effect.fn("readOllamaUsageLimits")(function* (apiKey: string) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const failed = (message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message });
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(OLLAMA_BALANCE_URL).pipe(HttpClientRequest.bearerToken(apiKey)),
    );
    if (response.status === 401) return failed("Ollama rejected OLLAMA_API_KEY.");
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(BalanceResponse)),
    );
    const digest = yield* Digest.Digest;
    // The same key on another environment is the same account, so it counts once in the pool.
    const credentialFingerprint = yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(`ollama\0${apiKey}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return {
      ...makeUsageLimits({ checkedAt, windows: ollamaBalanceWindows(body.included) }),
      credentialFingerprint,
    };
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => failed("Could not read Ollama cloud usage.")),
  );
});
