import type { ScheduledTaskWebhookEndpoint } from "@d4research/contracts";
import { isLocalLoopbackHost } from "@d4research/shared/hostClassification";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export interface WebhookAddress {
  readonly address: string;
  readonly copyable: boolean;
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
  resolve: MFunctionType = mFallback,
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: resolve(msg("Connect to this environment to resolve its webhook address.")),
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? resolve(
          msg(
            "Only this computer can call this address. Use a reachable HTTPS proxy for cloud services.",
          ),
        )
      : resolve(
          msg(
            "Works wherever this environment's address is reachable, for example over Tailscale or your own proxy.",
          ),
        ),
  };
}
