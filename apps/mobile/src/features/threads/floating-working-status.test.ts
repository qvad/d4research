import { describe, expect, it, vi } from "vite-plus/test";

import { connectionFloatingStatus, connectionRetryLabel } from "./floating-working-status";

const status = (
  connectionState: Parameters<typeof connectionFloatingStatus>[0]["connectionState"],
  overrides: { connectionError?: string | null; environmentLabel?: string | null } = {},
) =>
  connectionFloatingStatus({
    connectionError: overrides.connectionError ?? null,
    connectionState,
    environmentLabel:
      overrides.environmentLabel === undefined ? "Mac mini" : overrides.environmentLabel,
    onReconnect: () => {},
  });

describe("connectionFloatingStatus", () => {
  it("yields the pill to sync and working state once connected", () => {
    expect(status("connected")).toBeNull();
  });

  it("shows retry progress in the header instead of the floating pill", () => {
    expect(status("connecting")).toBeNull();
    expect(status("reconnecting", { connectionError: "ECONNREFUSED" })).toBeNull();
    expect(connectionRetryLabel({ connectionState: "connecting", connectionError: null })).toBe(
      "Reconnecting…",
    );
    expect(
      connectionRetryLabel({ connectionState: "reconnecting", connectionError: "ECONNREFUSED" }),
    ).toBe("Retrying connection…");
  });

  it("reports why the environment is unreachable", () => {
    expect(status("offline")).toMatchObject({
      kind: "connection",
      label: "You are offline",
    });
    expect(status("available")).toMatchObject({
      kind: "connection",
      label: "Mac mini is not connected",
    });
    expect(status("error", { connectionError: "handshake timed out" })).toMatchObject({
      label: "Failed to connect to Mac mini: handshake timed out",
    });
    expect(status("error")).toMatchObject({ label: "Failed to connect to Mac mini" });
  });

  it("falls back to a generic name when the environment has no label", () => {
    expect(status("error", { environmentLabel: null })).toMatchObject({
      label: "Failed to connect to Environment",
    });
  });

  it("carries the reconnect handler so the pill can trigger it", () => {
    const onReconnect = vi.fn();
    const pill = connectionFloatingStatus({
      connectionError: null,
      connectionState: "offline",
      environmentLabel: "Mac mini",
      onReconnect,
    });
    if (pill?.kind !== "connection") throw new Error("expected a connection pill");
    pill.onPress();
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});
