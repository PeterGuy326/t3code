import {
  TeamArtifactContent,
  TeamArtifactInput,
  TeamBoard,
  TeamBoardView,
  TeamWorkCommand,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as TeamWork from "../../../teamWork/TeamWorkService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    TeamWork.TeamWorkService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
export const TeamWorkToolkit = Toolkit.make(
  Tool.make("team_work_list", {
    ...shared,
    description:
      "Read workspace goals, owners, tracked tasks, execution observations, immutable deliveries and handoffs. Read before claiming or continuing work.",
    parameters: Tool.EmptyParams,
    success: TeamBoardView,
  }).annotate(Tool.Readonly, true),
  Tool.make("team_work_update", {
    ...shared,
    description:
      "A workspace's bound owner may dispatch and launch tasks in that workspace or its descendants, using expectedRevision and a stable commandId. Launches use supervised T3 execution. Record stopped-execution deliveries and handoff receipts. Human acceptance and workspace configuration remain workbench actions.",
    parameters: Schema.Struct({ command: TeamWorkCommand }),
    success: TeamBoard,
  }).annotate(Tool.Destructive, true),
  Tool.make("team_work_artifact", {
    ...shared,
    description:
      "Read a pinned artifact version as base64 bytes with its path and SHA-256. Reuse these bytes; do not regenerate an existing deliverable from a summary.",
    parameters: TeamArtifactInput,
    success: TeamArtifactContent,
  }).annotate(Tool.Readonly, true),
);
