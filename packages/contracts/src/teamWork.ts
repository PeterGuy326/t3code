import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(16_384));
const Id = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
const TextList = Schema.Array(Text).check(Schema.isMaxLength(64));
const IdList = Schema.Array(Id).check(Schema.isMaxLength(64));

export const TeamCoordination = Schema.Struct({
  phase: Schema.Literals(["planning", "running", "paused", "review"]),
  approved: Schema.Boolean,
  modelSelection: ModelSelection,
  taskIds: IdList,
  turns: NonNegativeInt,
  dispatchId: Id,
  pending: Schema.Boolean,
  note: Schema.String,
});

export const TeamWorkspace = Schema.Struct({
  id: Id,
  projectId: ProjectId,
  parentId: Schema.NullOr(Id),
  title: Text,
  objective: Text,
  owner: Text,
  ownerThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  coordination: Schema.optional(TeamCoordination),
});
export type TeamWorkspace = typeof TeamWorkspace.Type;

export const TeamAttempt = Schema.Struct({
  id: Id,
  threadId: ThreadId,
  workspaceId: Id,
  team: Text,
  generation: NonNegativeInt,
  briefing: Text,
  createdAt: Schema.String,
  launchState: Schema.Literals(["pending", "started", "unknown"]),
  modelSelection: ModelSelection,
  baseRef: Text,
  inputDeliveryIds: Schema.optional(IdList),
});
export type TeamAttempt = typeof TeamAttempt.Type;

export const TeamTask = Schema.Struct({
  id: Id,
  workspaceId: Id,
  assignedWorkspaceId: Id,
  title: Text,
  requirement: Text,
  criteria: TextList,
  team: Text,
  dependsOn: IdList,
  stage: Schema.Literals(["ready", "working", "blocked", "review", "done", "cancelled"]),
  generation: NonNegativeInt,
  attempts: Schema.Array(TeamAttempt),
  deliveryId: Schema.NullOr(Id),
  handoffId: Schema.NullOr(Id),
  note: Schema.String,
});
export type TeamTask = typeof TeamTask.Type;

export const TeamArtifact = Schema.Struct({
  id: Id,
  path: Text,
  digest: Text,
  bytes: NonNegativeInt,
});
export type TeamArtifact = typeof TeamArtifact.Type;

export const TeamDelivery = Schema.Struct({
  id: Id,
  taskId: Id,
  attemptId: Id,
  threadId: ThreadId,
  generation: NonNegativeInt,
  summary: Text,
  executionStatus: Schema.optional(
    Schema.Literals(["completed", "failed", "interrupted", "cancelled"]),
  ),
  artifacts: Schema.Array(TeamArtifact),
  checks: TextList,
  remaining: TextList,
  createdAt: Schema.String,
});
export type TeamDelivery = typeof TeamDelivery.Type;

export const TeamHandoff = Schema.Struct({
  id: Id,
  taskId: Id,
  deliveryId: Id,
  fromWorkspaceId: Id,
  toWorkspaceId: Id,
  toTeam: Text,
  generation: NonNegativeInt,
  nextSteps: Text,
  state: Schema.Literals(["offered", "accepted", "rejected", "revoked"]),
  receipt: Schema.NullOr(Text),
  createdAt: Schema.String,
});
export type TeamHandoff = typeof TeamHandoff.Type;

export const TeamAcceptance = Schema.Struct({
  taskId: Id,
  deliveryId: Id,
  accepted: Schema.Boolean,
  reason: Text,
  createdAt: Schema.String,
});

export const TeamBoard = Schema.Struct({
  revision: NonNegativeInt,
  workspaces: Schema.Array(TeamWorkspace),
  tasks: Schema.Array(TeamTask),
  deliveries: Schema.Array(TeamDelivery),
  handoffs: Schema.Array(TeamHandoff),
  acceptances: Schema.Array(TeamAcceptance),
});
export type TeamBoard = typeof TeamBoard.Type;
export const TeamBoardView = Schema.Struct({
  board: TeamBoard,
  owners: Schema.Array(
    Schema.Struct({ workspaceId: Id, status: Schema.String, active: Schema.Boolean }),
  ),
  executions: Schema.Array(
    Schema.Struct({
      taskId: Id,
      attemptId: Id,
      threadId: ThreadId,
      status: Schema.String,
      active: Schema.Boolean,
      observedAt: Schema.String,
    }),
  ),
});
export type TeamBoardView = typeof TeamBoardView.Type;

export const TeamExecutionInput = Schema.Struct({ taskId: Id });
export const TeamExecutionResult = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  checkoutRoot: Schema.NullOr(Schema.String),
  status: Schema.String,
  active: Schema.Boolean,
  finalText: Schema.String,
});
export const TeamKnowledgeInput = Schema.Struct({ workspaceId: Id });
export const TeamKnowledgeResult = Schema.Struct({
  directory: Schema.String,
  notes: Schema.Array(
    Schema.Struct({ path: Schema.String, digest: Schema.String, text: Schema.String }),
  ),
  limited: Schema.Boolean,
});

const Command = {
  commandId: Id.check(Schema.isMaxLength(96)),
  expectedRevision: NonNegativeInt,
};
export const TeamWorkCommand = Schema.Union([
  Schema.Struct({
    ...Command,
    type: Schema.Literal("workspace.coordinate"),
    workspaceId: Id,
    action: Schema.Literals(["plan", "start", "pause", "resume", "reset"]),
    modelSelection: Schema.optional(ModelSelection),
  }),
  Schema.Struct({ ...Command, type: Schema.Literal("workspace.create"), workspace: TeamWorkspace }),
  Schema.Struct({
    ...Command,
    type: Schema.Literal("workspace.update"),
    workspaceId: Id,
    owner: Text,
    objective: Text,
    ownerThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  }),
  Schema.Struct({
    ...Command,
    type: Schema.Literal("task.create"),
    actorWorkspaceId: Id,
    taskId: Id,
    workspaceId: Id,
    title: Text,
    requirement: Text,
    criteria: TextList,
    team: Text,
    dependsOn: IdList,
  }),
  Schema.Struct({
    ...Command,
    type: Schema.Literal("task.launch"),
    actorWorkspaceId: Id,
    taskId: Id,
    modelSelection: ModelSelection,
    baseRef: Text,
  }),
  Schema.Struct({
    ...Command,
    type: Schema.Literal("task.deliver"),
    actorWorkspaceId: Id,
    taskId: Id,
    attemptId: Id,
    summary: Text,
    paths: TextList,
    checks: TextList,
    remaining: TextList,
  }),
  Schema.Struct({
    ...Command,
    type: Schema.Literal("task.stage"),
    actorWorkspaceId: Id,
    taskId: Id,
    stage: Schema.Literals(["ready", "blocked", "cancelled"]),
    reason: Text,
  }),
  Schema.Struct({
    ...Command,
    type: Schema.Literal("handoff.offer"),
    actorWorkspaceId: Id,
    taskId: Id,
    toWorkspaceId: Id,
    toTeam: Text,
    nextSteps: Text,
  }),
  Schema.Struct({
    ...Command,
    type: Schema.Literal("handoff.respond"),
    actorWorkspaceId: Id,
    handoffId: Id,
    accept: Schema.Boolean,
    receipt: Text,
  }),
  Schema.Struct({
    ...Command,
    type: Schema.Literal("handoff.revoke"),
    actorWorkspaceId: Id,
    handoffId: Id,
  }),
  Schema.Struct({
    ...Command,
    type: Schema.Literal("delivery.accept"),
    actorWorkspaceId: Id,
    taskId: Id,
    deliveryId: Id,
    accepted: Schema.Boolean,
    criteriaConfirmed: Schema.Array(Schema.Boolean),
    reason: Text,
  }),
]);
export type TeamWorkCommand = typeof TeamWorkCommand.Type;

export const TeamExportInput = Schema.Struct({ workspaceId: Id });
export type TeamExportInput = typeof TeamExportInput.Type;
export const TeamExportResult = Schema.Struct({
  directory: Schema.String,
  revision: NonNegativeInt,
});
export const TeamArtifactInput = Schema.Struct({ artifactId: Id });
export type TeamArtifactInput = typeof TeamArtifactInput.Type;
export const TeamArtifactContent = Schema.Struct({ artifact: TeamArtifact, base64: Schema.String });
export class TeamWorkError extends Schema.TaggedError<TeamWorkError>()("TeamWorkError", {
  code: Schema.Literals(["conflict", "invalid", "busy", "missing", "unavailable", "storage"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
