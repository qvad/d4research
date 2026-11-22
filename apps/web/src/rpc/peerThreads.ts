import { createEnvironmentRpcCommand } from "@d4research/client-runtime/state/runtime";
import type { EnvironmentId, PeerThreadOperation } from "@d4research/contracts";
import { WS_METHODS } from "@d4research/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atomRegistry";

const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:peer-thread-request",
  tag: WS_METHODS.peerThreadsRequest,
  concurrency: { mode: "parallel" },
});

/** Loaded lazily by the relay because the command runtime includes that relay. */
export const perform = (environmentId: EnvironmentId, input: PeerThreadOperation) =>
  command.run(appAtomRegistry, { environmentId, input });
