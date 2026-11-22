import * as Option from "effect/Option";
import type { EnvironmentId } from "@d4research/contracts";
import { createEnvironmentProjectAtoms } from "@d4research/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@d4research/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@d4research/client-runtime/state/runtime";
import { WS_METHODS } from "@d4research/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell, environmentSnapshotAtom, expectsPrimaryEnvironment } from "./shell";
import { parseScopedProjectKey } from "@d4research/client-runtime/environment";
import { AVAILABLE_CONNECTION_STATE } from "@d4research/client-runtime/connection";
import { AsyncResult, Atom } from "effect/reactivity";
import { serverEnvironment } from "./server";

export const agentProjectIdAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const identity = get(serverEnvironment.d4AgentIdentity({ environmentId, input: {} }));
    return Option.getOrNull(AsyncResult.value(identity))?.projectId ?? null;
  }),
);

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
  agentProjectIdAtom,
});
export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  projectAtom: environmentProjects.projectAtom,
});
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:search-contents",
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

export const defaultProjectFallbackReadyAtom = Atom.family((projectKey: string | null) =>
  Atom.make((get) => {
    const remembered = projectKey === null ? null : parseScopedProjectKey(projectKey);
    if (!remembered) return true;
    const catalog = get(environmentCatalog.catalogValueAtom);
    if (!catalog.isReady) return false;
    if (
      expectsPrimaryEnvironment() &&
      !Array.from(catalog.entries.values()).some(
        (entry) => entry.target._tag === "PrimaryConnectionTarget",
      )
    )
      return false;
    const entry = catalog.entries.get(remembered.environmentId);
    if (!entry?.enabled || entry.unsupportedReason !== undefined) return true;
    if (get(environmentShell.statusAtom(remembered.environmentId)) === "live") return true;
    const connection = AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(remembered.environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    );
    return (
      connection.phase === "offline" ||
      connection.phase === "blocked" ||
      (connection.phase === "backoff" && connection.attempt > 2)
    );
  }).pipe(Atom.withLabel(`web-default-project-fallback-ready:${projectKey}`)),
);
