import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import type { EnvironmentId } from "@d4research/contracts";

export function resolveAutoSettleReferenceEnvironmentId(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly canWriteSettings: boolean | null;
  }>,
): EnvironmentId | null {
  for (const environment of environments) {
    if (environment.canWriteSettings === null) return null;
    if (environment.canWriteSettings) return environment.environmentId;
  }
  return environments[0]?.environmentId ?? null;
}

export function resolveAgentAwarenessPlatformPresentation(
  platform: string,
  resolve: MessageResolver = m,
): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios" || platform === "android"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: resolve(msg("Unavailable on this platform")) };
}
