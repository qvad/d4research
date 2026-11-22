import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";
import type { EnvironmentId } from "@d4research/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { environmentShell } from "../state/shell";
import { createWidgetRefresher, WIDGET_REFRESH_INTERVAL } from "./subscriptionUsageSnapshot";

// A shell that failed never goes live, and its environment still needs fresh quotas.
const shellSettledAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    return shell.status === "live" || Option.isSome(shell.error);
  }),
);

/**
 * Connected environments whose thread list has loaded. A refresh re-probes every provider on
 * the host, so on a cold start it waits until it cannot compete with the thread list.
 */
const refreshableEnvironmentsAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom)]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" && get(shellSettledAtom(environmentId)),
    )
    .map(([environmentId]) => environmentId),
);

export function useSubscriptionUsage(enabled = true) {
  const connected = useAtomValue(refreshableEnvironmentsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refresh = useMemo(
    () =>
      createWidgetRefresher(
        (environmentId: Parameters<typeof refreshProviders>[0]["environmentId"]) =>
          refreshProviders({ environmentId, input: {} }),
      ),
    [refreshProviders],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh widget usage on native app activation and release the refresh timer on unmount.
  useEffect(() => {
    const update = () => {
      if (!enabled || AppState.currentState !== "active") return;
      void refresh(connected, Date.now());
    };
    update();
    const subscription = AppState.addEventListener("change", update);
    const timer = setInterval(update, WIDGET_REFRESH_INTERVAL);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [enabled, connected, refresh]);
}
