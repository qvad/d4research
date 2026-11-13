import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@d4research/contracts";
import { clampPercent, makeUsageLimits } from "@d4research/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";

import { LATEST_DATE_MS, type MuseSubscriptionUsage } from "./protocol.ts";

const formatMillis = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function museUsageWindows(usage: MuseSubscriptionUsage) {
  return [
    {
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: clampPercent(usage.window.usedPercent),
      resetsAt: formatMillis(usage.window.resetsAtMs),
      windowDurationMins: usage.window.windowDurationMins,
    },
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: clampPercent(usage.weekly.usedPercent),
      resetsAt: formatMillis(usage.weekly.resetsAtMs),
      windowDurationMins: 7 * 24 * 60,
    },
  ] satisfies ServerProviderUsageWindow[];
}

/**
 * Muse reports usage only while model traffic arrives, so a reading keeps its observation time,
 * and a window whose reset has passed is unknown rather than empty.
 */
export function museUsageLimits(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
): ServerProviderUsageLimits {
  const windows =
    usage === undefined
      ? []
      : museUsageWindows(usage).filter((window) => Date.parse(window.resetsAt) > nowMs);
  return makeUsageLimits({
    checkedAt: formatMillis(usage !== undefined && windows.length > 0 ? usage.observedAtMs : nowMs),
    windows,
  });
}

/** Credential proxies may omit error.quota from 429 refusals; inspect text too. */
export function isMuseUsageLimitFailure(message: string | undefined): boolean {
  return message !== undefined && /\b429\b/.test(message) && /quota|usage limit/i.test(message);
}

const NAMED_RESET =
  /\bresets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;

/** Resume only after all exhausted windows reset; use the latest future reset from quota, refusal, or usage. */
export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal?: {
    readonly quota?: { readonly resetsAtMs: number } | undefined;
    readonly message?: string | undefined;
  },
): string | null {
  const named = refusal?.message?.match(NAMED_RESET)?.[1];
  const resets = [
    ...[usage?.window, usage?.weekly].map((window) =>
      window && window.usedPercent >= 100 ? window.resetsAtMs : undefined,
    ),
    refusal?.quota?.resetsAtMs,
    named === undefined ? undefined : Date.parse(named),
  ].filter(
    (ms): ms is number =>
      ms !== undefined && Number.isFinite(ms) && ms > nowMs && ms <= LATEST_DATE_MS,
  );
  return resets.length > 0 ? formatMillis(Math.max(...resets)) : null;
}
