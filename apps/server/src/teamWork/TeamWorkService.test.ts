// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  TeamWorkError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type TeamWorkCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as TeamWork from "./TeamWorkService.ts";

const model = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
function shell(threadId: ThreadId, root: string): OrchestrationV2ThreadShell {
  const now = DateTime.makeUnsafe("2026-10-25T00:00:00Z");
  return {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Task execution",
    providerInstanceId: model.instanceId,
    modelSelection: model,
    runtimeMode: "approval-required",
    interactionMode: "default",
    worktreePath: root,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    status: "completed",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestUserMessageAt: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
  };
}
function fixture(root: string) {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const launches: ThreadLaunch.ThreadLaunchInput[] = [];
  const ownerMessages: string[] = [];
  const beforeShellRead = new Map<ThreadId, Effect.Effect<void>>();
  const dependencies = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => {
          ownerMessages.push(command.type);
          return { sequence: 1, storedEvents: [] };
        }),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) =>
        Effect.succeed(
          projectId === "project"
            ? Option.some({
                projectId,
                title: "Project",
                workspaceRoot: root,
                defaultModelSelection: model,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                createdAt: "now",
                updatedAt: "now",
                deletedAt: null,
              })
            : Option.none(),
        ),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (id) =>
        Effect.gen(function* () {
          yield* beforeShellRead.get(id) ?? Effect.void;
          return shells.get(id) ?? null;
        }),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          const thread = shell(input.threadId!, root);
          shells.set(thread.id, thread);
          return {
            threadId: thread.id,
            resumed: false,
            projection: {
              thread: { ...thread, lastVisitedAt: thread.lastVisitedAt ?? null },
              runs: [],
              attempts: [],
              nodes: [],
              subagents: [],
              providerSessions: [],
              providerThreads: [],
              providerTurns: [],
              runtimeRequests: [],
              messages: [],
              plans: [],
              turnItems: [],
              checkpointScopes: [],
              checkpoints: [],
              contextHandoffs: [],
              contextTransfers: [],
              visibleTurnItems: [],
              updatedAt: thread.updatedAt,
            },
          };
        }),
    }),
  );
  return { shells, launches, ownerMessages, beforeShellRead, dependencies, root };
}
function scenario(
  run: (
    context: ReturnType<typeof fixture>,
  ) => Effect.Effect<
    void,
    TeamWorkError | SqlError,
    TeamWork.TeamWorkService | SqlClient.SqlClient
  >,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-team-service-"))),
        (directory) =>
          Effect.promise(async () => {
            if (
              NodePath.dirname(NodePath.resolve(directory)) !== NodePath.resolve(NodeOS.tmpdir()) ||
              !NodePath.basename(directory).startsWith("t3-team-service-")
            )
              throw new Error("Unexpected test cleanup path");
            await NodeFSP.rm(directory, { recursive: true, force: true });
          }),
      );
      const context = fixture(root);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "result.md"), "Reusable implementation\n"),
      );
      const testLayer = TeamWork.layer.pipe(
        Layer.provideMerge(context.dependencies),
        Layer.provideMerge(Layer.fresh(Sqlite.layerMemory)),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* run(context).pipe(Effect.provide(testLayer));
    }),
  );
}

const seed = Effect.gen(function* () {
  const service = yield* TeamWork.TeamWorkService;
  let board = (yield* service.list).board;
  board = yield* service.execute({
    commandId: "workspace",
    expectedRevision: board.revision,
    type: "workspace.create",
    workspace: {
      id: "scope",
      projectId: ProjectId.make("project"),
      parentId: null,
      title: "Product",
      objective: "Ship the product",
      owner: "Owner",
    },
  });
  return yield* service.execute({
    commandId: "task",
    expectedRevision: board.revision,
    type: "task.create",
    actorWorkspaceId: "scope",
    taskId: "task",
    workspaceId: "scope",
    title: "Implement",
    requirement: "Reuse existing work",
    criteria: ["File is correct"],
    team: "Codex team",
    dependsOn: [],
  });
});

it.live("requires plan approval, preserves launch identity and pauses new dispatches", () =>
  scenario((context) =>
    Effect.gen(function* () {
      const service = yield* TeamWork.TeamWorkService;
      let board = yield* seed;
      const plan = {
        commandId: "plan",
        expectedRevision: board.revision,
        type: "workspace.coordinate" as const,
        workspaceId: "scope",
        action: "plan" as const,
        modelSelection: model,
      };
      board = yield* service.execute(plan);
      yield* service.execute(plan);
      expect(context.launches).toHaveLength(1);
      expect(context.launches[0]!.threadId).toBe("owner-plan");
      board = yield* service.execute({
        commandId: "planned",
        expectedRevision: board.revision,
        type: "task.create",
        actorWorkspaceId: "scope",
        workspaceId: "scope",
        taskId: "planned",
        title: "Implement",
        requirement: "Write result.md",
        criteria: ["File exists"],
        team: "Developer",
        dependsOn: [],
      });
      const launch = {
        commandId: "worker",
        expectedRevision: board.revision,
        type: "task.launch" as const,
        actorWorkspaceId: "scope",
        taskId: "planned",
        modelSelection: model,
        baseRef: "HEAD",
      };
      expect((yield* Effect.result(service.execute(launch)))._tag).toBe("Failure");
      expect(context.launches).toHaveLength(1);
      board = yield* service.execute({
        commandId: "approve",
        expectedRevision: board.revision,
        type: "workspace.coordinate",
        workspaceId: "scope",
        action: "start",
      });
      expect(context.ownerMessages).toHaveLength(1);
      board = yield* service.execute({
        commandId: "pause",
        expectedRevision: board.revision,
        type: "workspace.coordinate",
        workspaceId: "scope",
        action: "pause",
      });
      const count = context.launches.length;
      yield* service.reconcile;
      expect(context.launches).toHaveLength(count);
      expect(
        (yield* Effect.result(service.execute({ ...launch, expectedRevision: board.revision })))
          ._tag,
      ).toBe("Failure");
      board = yield* service.execute({
        commandId: "resume",
        expectedRevision: board.revision,
        type: "workspace.coordinate",
        workspaceId: "scope",
        action: "resume",
      });
      board = yield* service.execute({ ...launch, expectedRevision: board.revision });
      const worker = board.tasks.find((item) => item.id === "planned")!;
      context.shells.set(worker.attempts[0]!.threadId, {
        ...context.shells.get(worker.attempts[0]!.threadId)!,
        status: "running",
      });
      const activeCount = context.ownerMessages.length;
      yield* service.reconcile;
      expect(context.ownerMessages).toHaveLength(activeCount);
      context.shells.set(worker.attempts[0]!.threadId, {
        ...context.shells.get(worker.attempts[0]!.threadId)!,
        status: "completed",
      });
      yield* service.reconcile;
      expect(context.ownerMessages).toHaveLength(activeCount + 1);
      expect((yield* service.list).board.workspaces[0]!.coordination!.turns).toBe(1);
      board = (yield* service.list).board;
      board = yield* service.execute({
        commandId: "end-pause",
        expectedRevision: board.revision,
        type: "workspace.coordinate",
        workspaceId: "scope",
        action: "pause",
      });
      board = yield* service.execute({
        commandId: "end",
        expectedRevision: board.revision,
        type: "workspace.coordinate",
        workspaceId: "scope",
        action: "reset",
      });
      expect(board.workspaces[0]!.ownerThreadId).toBeNull();
      expect(board.workspaces[0]!.coordination).toBeUndefined();
      expect(board.tasks.find((item) => item.id === "planned")!.attempts).toHaveLength(1);
    }),
  ),
);

it.live("keeps the coordinator alive when a campaign ends during a shell observation", () =>
  scenario((context) =>
    Effect.gen(function* () {
      const service = yield* TeamWork.TeamWorkService;
      let board = yield* seed;
      board = yield* service.execute({
        commandId: "plan",
        expectedRevision: board.revision,
        type: "workspace.coordinate",
        workspaceId: "scope",
        action: "plan",
        modelSelection: model,
      });
      board = yield* service.execute({
        commandId: "draft",
        expectedRevision: board.revision,
        type: "task.create",
        actorWorkspaceId: "scope",
        workspaceId: "scope",
        taskId: "draft",
        title: "Draft",
        requirement: "Write result.md",
        criteria: ["File correct"],
        team: "Developer",
        dependsOn: [],
      });
      board = yield* service.execute({
        commandId: "approve",
        expectedRevision: board.revision,
        type: "workspace.coordinate",
        workspaceId: "scope",
        action: "start",
      });
      const ownerId = board.workspaces[0]!.ownerThreadId!;
      context.beforeShellRead.set(
        ownerId,
        Effect.gen(function* () {
          context.beforeShellRead.delete(ownerId);
          const latest = (yield* service.list).board;
          const paused = yield* service.execute({
            commandId: "pause",
            expectedRevision: latest.revision,
            type: "workspace.coordinate",
            workspaceId: "scope",
            action: "pause",
          });
          yield* service.execute({
            commandId: "end",
            expectedRevision: paused.revision,
            type: "workspace.coordinate",
            workspaceId: "scope",
            action: "reset",
          });
        }).pipe(Effect.orDie),
      );
      yield* service.reconcile;
      expect((yield* service.list).board.workspaces[0]!.coordination).toBeUndefined();
      expect(context.ownerMessages).toHaveLength(1);
      expect(context.launches).toHaveLength(1);
    }),
  ),
);

it.live(
  "lets an approved reviewer consume pinned bytes in the original checkout without human acceptance",
  () =>
    scenario((context) =>
      Effect.gen(function* () {
        const service = yield* TeamWork.TeamWorkService;
        let board = yield* seed;
        board = yield* service.execute({
          commandId: "plan",
          expectedRevision: board.revision,
          type: "workspace.coordinate",
          workspaceId: "scope",
          action: "plan",
          modelSelection: model,
        });
        for (const [taskId, dependsOn] of [
          ["dev", []],
          ["reviewer", ["dev"]],
          ["audit", ["dev"]],
        ] as const) {
          board = yield* service.execute({
            commandId: `create-${taskId}`,
            expectedRevision: board.revision,
            type: "task.create",
            actorWorkspaceId: "scope",
            workspaceId: "scope",
            taskId,
            title: taskId,
            requirement: "Reuse result.md",
            criteria: ["File correct"],
            team: taskId,
            dependsOn,
          });
        }
        board = yield* service.execute({
          commandId: "approve",
          expectedRevision: board.revision,
          type: "workspace.coordinate",
          workspaceId: "scope",
          action: "start",
        });
        const launch = (taskId: string): TeamWorkCommand => ({
          commandId: `launch-${taskId}`,
          expectedRevision: board.revision,
          type: "task.launch",
          actorWorkspaceId: "scope",
          taskId,
          modelSelection: model,
          baseRef: "HEAD",
        });
        expect((yield* Effect.result(service.execute(launch("reviewer"))))._tag).toBe("Failure");
        board = yield* service.execute(launch("dev"));
        board = yield* service.execute({
          commandId: "capture",
          expectedRevision: board.revision,
          type: "task.deliver",
          actorWorkspaceId: "scope",
          taskId: "dev",
          attemptId: "launch-dev",
          summary: "Implemented",
          paths: ["result.md"],
          checks: ["File checked"],
          remaining: [],
        });
        expect(board.acceptances).toHaveLength(0);
        board = yield* service.execute(launch("reviewer"));
        expect(context.launches.at(-1)!.workspaceStrategy).toEqual({
          type: "existing_worktree",
          worktreePath: context.root,
        });
        expect(board.tasks.find((item) => item.id === "dev")!.stage).toBe("review");
        const delivery = board.deliveries[0]!;
        const pinned = yield* service.artifact({ artifactId: delivery.artifacts[0]!.id });
        expect(Buffer.from(pinned.base64, "base64").toString()).toBe("Reusable implementation\n");
        expect(board.tasks.find((item) => item.id === "reviewer")!.attempts[0]!.briefing).toContain(
          delivery.artifacts[0]!.digest,
        );
        expect(
          board.tasks.find((item) => item.id === "reviewer")!.attempts[0]!.inputDeliveryIds,
        ).toEqual([delivery.id]);
        expect((yield* Effect.result(service.execute(launch("audit"))))._tag).toBe("Failure");
      }),
    ),
);

it.live("preserves cancelled work for a successor without inventing a successful execution", () =>
  scenario((context) =>
    Effect.gen(function* () {
      const service = yield* TeamWork.TeamWorkService;
      let board = yield* seed;
      board = yield* service.execute({
        commandId: "partial-start",
        expectedRevision: board.revision,
        type: "task.launch",
        actorWorkspaceId: "scope",
        taskId: "task",
        modelSelection: model,
        baseRef: "HEAD",
      });
      const threadId = board.tasks[0]!.attempts.at(-1)!.threadId;
      context.shells.set(threadId, { ...context.shells.get(threadId)!, status: "cancelled" });
      board = yield* service.execute({
        commandId: "partial-delivery",
        expectedRevision: board.revision,
        type: "task.deliver",
        actorWorkspaceId: "scope",
        taskId: "task",
        attemptId: "partial-start",
        summary: "Preserve existing work before retrying",
        paths: ["result.md"],
        checks: [],
        remaining: ["Finish review"],
      });
      expect(board.deliveries[0]!.executionStatus).toBe("cancelled");
      expect(board.tasks[0]!.stage).toBe("review");
      expect(board.acceptances).toHaveLength(0);
      expect((yield* service.list).executions[0]!.status).toBe("cancelled");
    }),
  ),
);

it.live(
  "persists a cross-provider handoff, exact artifact bytes and an Obsidian archive with receipt history",
  () =>
    scenario((context) =>
      Effect.gen(function* () {
        const service = yield* TeamWork.TeamWorkService;
        let board = yield* seed;
        const launch: TeamWorkCommand = {
          commandId: "launch",
          expectedRevision: board.revision,
          type: "task.launch",
          actorWorkspaceId: "scope",
          taskId: "task",
          modelSelection: model,
          baseRef: "HEAD",
        };
        board = yield* service.execute(launch);
        yield* service.execute(launch);
        expect(context.launches).toHaveLength(1);
        board = yield* service.execute({
          commandId: "delivery",
          expectedRevision: board.revision,
          type: "task.deliver",
          actorWorkspaceId: "scope",
          taskId: "task",
          attemptId: "launch",
          summary: "Implementation ready",
          paths: ["result.md"],
          checks: ["Compared exact bytes"],
          remaining: ["Review"],
        });
        const artifact = board.deliveries[0]!.artifacts[0]!;
        board = yield* service.execute({
          commandId: "handoff",
          expectedRevision: board.revision,
          type: "handoff.offer",
          actorWorkspaceId: "scope",
          taskId: "task",
          toWorkspaceId: "scope",
          toTeam: "Hermes review team",
          nextSteps: "Continue from result.md",
        });
        board = yield* service.execute({
          commandId: "accept-handoff",
          expectedRevision: board.revision,
          type: "handoff.respond",
          actorWorkspaceId: "scope",
          handoffId: "handoff",
          accept: true,
          receipt: "Received result.md. Will review the existing implementation.",
        });
        expect(board.tasks[0]).toMatchObject({
          team: "Hermes review team",
          generation: 1,
          id: "task",
          deliveryId: "delivery",
        });
        const reloaded = yield* service.list.pipe(
          Effect.provide(TeamWork.layer.pipe(Layer.provide(context.dependencies))),
        );
        expect(reloaded.board).toEqual(board);
        const archived = yield* service.exportVault({ workspaceId: "scope" });
        const md = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(archived.directory, "handoff-handoff.md"), "utf8"),
        );
        expect(md).toContain("Received result.md");
        expect(md).toContain("[[delivery-delivery");
        board = yield* service.execute({
          commandId: "review-start",
          expectedRevision: board.revision,
          type: "task.launch",
          actorWorkspaceId: "scope",
          taskId: "task",
          modelSelection: { ...model, instanceId: ProviderInstanceId.make("hermes") },
          baseRef: "HEAD",
        });
        expect(context.launches.at(-1)!.workspaceStrategy).toEqual({
          type: "existing_worktree",
          worktreePath: context.root,
        });
        expect(context.launches.at(-1)!.modelSelection.instanceId).toBe("hermes");
        expect(context.launches.at(-1)!.initialMessage!.text).toContain(artifact.digest);
        const lateDelivery = yield* Effect.result(
          service.execute({
            commandId: "late-old-team",
            expectedRevision: board.revision,
            type: "task.deliver",
            actorWorkspaceId: "scope",
            taskId: "task",
            attemptId: "launch",
            summary: "Late result",
            paths: ["result.md"],
            checks: [],
            remaining: [],
          }),
        );
        expect(lateDelivery._tag).toBe("Failure");
        board = yield* service.execute({
          commandId: "retry-review",
          expectedRevision: board.revision,
          type: "task.stage",
          actorWorkspaceId: "scope",
          taskId: "task",
          stage: "ready",
          reason: "Verify changed source handling",
        });
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(context.root, "result.md"), "unrelated later version"),
        );
        const saved = yield* service.artifact({ artifactId: artifact.id });
        expect(Buffer.from(saved.base64, "base64").toString()).toBe("Reusable implementation\n");
        const before = context.launches.length;
        const refused = yield* Effect.result(
          service.execute({
            commandId: "launch-review",
            expectedRevision: board.revision,
            type: "task.launch",
            actorWorkspaceId: "scope",
            taskId: "task",
            modelSelection: { ...model, instanceId: ProviderInstanceId.make("hermes") },
            baseRef: "HEAD",
          }),
        );
        expect(refused._tag).toBe("Failure");
        expect(context.launches).toHaveLength(before);
      }),
    ),
);

it.live(
  "rejects stale updates, conflicting command retries, active-source handoffs and corrupt artifact bytes",
  () =>
    scenario((context) =>
      Effect.gen(function* () {
        const service = yield* TeamWork.TeamWorkService;
        const sql = yield* SqlClient.SqlClient;
        let board = yield* seed;
        const stale = yield* Effect.result(
          service.execute({
            commandId: "stale",
            expectedRevision: 0,
            type: "workspace.update",
            workspaceId: "scope",
            owner: "Other",
            objective: "Other",
          }),
        );
        expect(stale._tag).toBe("Failure");
        const wrongRetry = yield* Effect.result(
          service.execute({
            commandId: "workspace",
            expectedRevision: board.revision,
            type: "workspace.update",
            workspaceId: "scope",
            owner: "Other",
            objective: "Other",
          }),
        );
        expect(wrongRetry._tag).toBe("Failure");
        board = yield* service.execute({
          commandId: "launch",
          expectedRevision: board.revision,
          type: "task.launch",
          actorWorkspaceId: "scope",
          taskId: "task",
          modelSelection: model,
          baseRef: "HEAD",
        });
        const id = board.tasks[0]!.attempts[0]!.threadId;
        context.shells.set(id, { ...context.shells.get(id)!, status: "running" });
        const busy = yield* Effect.result(
          service.execute({
            commandId: "stop-stage",
            expectedRevision: board.revision,
            type: "task.stage",
            actorWorkspaceId: "scope",
            taskId: "task",
            stage: "ready",
            reason: "Retry",
          }),
        );
        expect(busy._tag).toBe("Failure");
        context.shells.set(id, { ...context.shells.get(id)!, status: "completed" });
        board = yield* service.execute({
          commandId: "delivery",
          expectedRevision: board.revision,
          type: "task.deliver",
          actorWorkspaceId: "scope",
          taskId: "task",
          attemptId: "launch",
          summary: "Ready",
          paths: ["result.md"],
          checks: [],
          remaining: [],
        });
        board = yield* service.execute({
          commandId: "handoff",
          expectedRevision: board.revision,
          type: "handoff.offer",
          actorWorkspaceId: "scope",
          taskId: "task",
          toWorkspaceId: "scope",
          toTeam: "Review",
          nextSteps: "Review file",
        });
        const artifactId = board.deliveries[0]!.artifacts[0]!.id;
        yield* sql`UPDATE team_work_artifacts SET body = 'Y2hhbmdlZA==' WHERE artifact_id = ${artifactId}`;
        const corrupt = yield* Effect.result(
          service.execute({
            commandId: "takeover",
            expectedRevision: board.revision,
            type: "handoff.respond",
            actorWorkspaceId: "scope",
            handoffId: "handoff",
            accept: true,
            receipt: "Received",
          }),
        );
        expect(corrupt._tag).toBe("Failure");
        expect((yield* service.list).board.tasks[0]!.generation).toBe(0);
        const count = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM team_work_commands WHERE command_id = 'takeover'`;
        expect(count[0]!.count).toBe(0);
      }),
    ),
);
