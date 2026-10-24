import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const teamWorkList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "team-work:list",
  tag: WS_METHODS.teamWorkList,
  staleTimeMs: 10_000,
  idleTtlMs: 60_000,
});
export const teamWorkExecute = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "team-work:execute",
  tag: WS_METHODS.teamWorkExecute,
});
export const teamWorkExport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "team-work:export",
  tag: WS_METHODS.teamWorkExport,
});
export const teamWorkArtifact = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "team-work:artifact",
  tag: WS_METHODS.teamWorkArtifact,
  staleTimeMs: 300_000,
  idleTtlMs: 60_000,
});
