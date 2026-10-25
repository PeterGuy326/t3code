import {
  CommandId,
  MessageId,
  TeamBoard,
  TeamWorkError,
  ThreadId,
  type TeamBoardView,
  type TeamWorkCommand,
  type TeamExportInput,
  type TeamExportResult,
  type TeamArtifactInput,
  type TeamArtifactContent,
  type TeamExecutionInput,
  type TeamExecutionResult,
  type TeamKnowledgeInput,
  type TeamKnowledgeResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  applyPlanning,
  emptyBoard,
  inputDeliveryId,
  makeBriefing,
  reject,
  replaceTask,
  requireDependencies,
  requireScope,
  task,
  workspace,
} from "./model.ts";
import { hash, readArtifact, readKnowledge, writeVault, artifactExportName } from "./files.ts";
import { ownerBriefing } from "./coordination.ts";

export class TeamWorkService extends Context.Service<
  TeamWorkService,
  {
    readonly list: Effect.Effect<TeamBoardView, TeamWorkError>;
    readonly reconcile: Effect.Effect<void, TeamWorkError>;
    readonly execution: (
      input: typeof TeamExecutionInput.Type,
    ) => Effect.Effect<typeof TeamExecutionResult.Type, TeamWorkError>;
    readonly knowledge: (
      input: typeof TeamKnowledgeInput.Type,
    ) => Effect.Effect<typeof TeamKnowledgeResult.Type, TeamWorkError>;
    readonly execute: (command: TeamWorkCommand) => Effect.Effect<TeamBoard, TeamWorkError>;
    readonly artifact: (
      input: TeamArtifactInput,
    ) => Effect.Effect<typeof TeamArtifactContent.Type, TeamWorkError>;
    readonly exportVault: (
      input: TeamExportInput,
    ) => Effect.Effect<typeof TeamExportResult.Type, TeamWorkError>;
  }
>()("t3/teamWork/TeamWorkService") {}

const isTeamWorkError = Schema.is(TeamWorkError);
const decodeBoard = Schema.decodeSync(Schema.fromJsonString(TeamBoard));
const error = (cause: unknown) =>
  isTeamWorkError(cause)
    ? cause
    : new TeamWorkError({
        code: "storage",
        message: "Could not complete the team workspace operation.",
        cause,
      });
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const boardString = Schema.encodeSync(Schema.fromJsonString(TeamBoard));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const attemptSync = <A>(run: () => A) => Effect.try({ try: run, catch: error });
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: error });
const terminal = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
  "idle",
]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const lock = yield* Semaphore.make(1);
  const ownerLock = yield* Semaphore.make(1);

  const load = Effect.fn("TeamWorkService.load")(function* () {
    const rows = yield* sql<{ body: string }>`SELECT body FROM team_work_state WHERE id = 1`;
    return yield* attemptSync(() => (rows[0] ? decodeBoard(rows[0].body) : emptyBoard()));
  });
  const project = Effect.fn("TeamWorkService.project")(function* (id: string, board: TeamBoard) {
    const scope = yield* attemptSync(() => workspace(board, id));
    const result = yield* projects.get(scope.projectId);
    return yield* attemptSync(
      () => Option.getOrNull(result) ?? reject("missing", "The linked T3 project is unavailable."),
    );
  });
  const assertIdle = Effect.fn("TeamWorkService.assertIdle")(function* (threadId: ThreadId) {
    const shell = yield* projections.getThreadShell(threadId);
    if (
      shell &&
      (!terminal.has(shell.status) ||
        shell.activeRunId !== null ||
        shell.pendingRuntimeRequest !== null ||
        (shell.pendingBackgroundTasks?.length ?? 0) > 0)
    ) {
      return yield* new TeamWorkError({
        code: "busy",
        message: "Stop the source agent and resolve its pending work before continuing.",
      });
    }
    return shell;
  });
  const persist = Effect.fn("TeamWorkService.persist")(function* (
    board: TeamBoard,
    commandId: string,
    body: string,
  ) {
    if (Buffer.byteLength(boardString(board)) > 8 * 1024 * 1024)
      return yield* new TeamWorkError({
        code: "invalid",
        message: "Workspace history is full. Export and archive before adding work.",
      });
    yield* sql`INSERT INTO team_work_state (id, revision, body) VALUES (1, ${board.revision}, ${boardString(board)})
      ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, body = excluded.body`;
    yield* sql`INSERT INTO team_work_events (revision, command_id, body, created_at)
      VALUES (${board.revision}, ${commandId}, ${body}, ${yield* nowIso})`;
  });
  const verifyDelivery = Effect.fn("TeamWorkService.verifyDelivery")(function* (
    board: TeamBoard,
    deliveryId: string,
  ) {
    const delivery = yield* attemptSync(
      () =>
        board.deliveries.find((item) => item.id === deliveryId) ??
        reject("missing", "Delivery is unavailable."),
    );
    yield* assertIdle(delivery.threadId);
    for (const artifact of delivery.artifacts) {
      const rows = yield* sql<{
        body: string;
        digest: string;
      }>`SELECT body, digest FROM team_work_artifacts WHERE artifact_id = ${artifact.id}`;
      yield* attemptSync(() => {
        if (
          !rows[0] ||
          hash(Buffer.from(rows[0].body, "base64")) !== artifact.digest ||
          rows[0].digest !== artifact.digest
        )
          reject(
            "unavailable",
            "A pinned artifact is missing or changed. Handoff was not accepted.",
          );
      });
    }
    return delivery;
  });
  const artifact = Effect.fn("TeamWorkService.artifact")(function* (input: TeamArtifactInput) {
    const board = yield* load();
    const found = yield* attemptSync(
      () =>
        board.deliveries
          .flatMap((item) => item.artifacts)
          .find((item) => item.id === input.artifactId) ??
        reject("missing", "Artifact was not found."),
    );
    const rows = yield* sql<{
      body: string;
    }>`SELECT body FROM team_work_artifacts WHERE artifact_id = ${input.artifactId}`;
    return yield* attemptSync(() => {
      if (!rows[0] || hash(Buffer.from(rows[0].body, "base64")) !== found.digest)
        reject("unavailable", "Artifact bytes are unavailable or changed.");
      return { artifact: found, base64: rows[0].body };
    });
  });

  const commit = Effect.fn("TeamWorkService.commit")(function* (command: TeamWorkCommand) {
    const { expectedRevision: _expectedRevision, ...intent } = command;
    const fingerprint = hash(stringify(intent));
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        let board = yield* load();
        const receipts = yield* sql<{
          fingerprint: string;
        }>`SELECT fingerprint FROM team_work_commands WHERE command_id = ${command.commandId}`;
        if (receipts[0]) {
          if (receipts[0].fingerprint !== fingerprint)
            return yield* new TeamWorkError({
              code: "conflict",
              message: "Command identity was reused for different work.",
            });
          return board;
        }
        if (command.expectedRevision !== board.revision)
          return yield* new TeamWorkError({
            code: "conflict",
            message: "Workspace changed. Refresh before trying again.",
          });
        const now = yield* nowIso;
        if (command.type === "workspace.create" && command.workspace.coordination)
          return yield* new TeamWorkError({
            code: "invalid",
            message: "Team coordination is created by the workbench.",
          });
        if (command.type === "workspace.update") {
          const scope = yield* attemptSync(() => workspace(board, command.workspaceId));
          if (
            scope.coordination &&
            ((command.ownerThreadId !== undefined &&
              command.ownerThreadId !== scope.ownerThreadId) ||
              command.objective !== scope.objective)
          )
            return yield* new TeamWorkError({
              code: "invalid",
              message:
                "Pause this campaign and create a new goal to change its scope or owner conversation.",
            });
        }
        if (command.type === "workspace.coordinate" && command.action !== "pause") {
          const scope = yield* attemptSync(() => workspace(board, command.workspaceId));
          if (scope.ownerThreadId) yield* assertIdle(scope.ownerThreadId);
          if (command.action === "reset") {
            for (const id of scope.coordination?.taskIds ?? []) {
              const attempt = task(board, id).attempts.at(-1);
              if (attempt) yield* assertIdle(attempt.threadId);
            }
          }
        }
        if (command.type === "workspace.create" || command.type === "workspace.update") {
          const ownerThreadId =
            command.type === "workspace.create"
              ? command.workspace.ownerThreadId
              : command.ownerThreadId;
          if (ownerThreadId) {
            const scopeProjectId =
              command.type === "workspace.create"
                ? command.workspace.projectId
                : workspace(board, command.workspaceId).projectId;
            const ownerThread = yield* projections.getThreadShell(ownerThreadId);
            if (
              !ownerThread ||
              ownerThread.projectId !== scopeProjectId ||
              ownerThread.deletedAt !== null ||
              ownerThreadId.startsWith("team-")
            )
              return yield* new TeamWorkError({
                code: "invalid",
                message: "Choose a durable owner conversation in this workspace's T3 project.",
              });
          }
        }
        if (command.type === "workspace.create") {
          const existing = yield* projects.get(command.workspace.projectId);
          if (Option.isNone(existing))
            return yield* new TeamWorkError({
              code: "missing",
              message: "Register an existing T3 project first.",
            });
        }
        if ("taskId" in command && command.type !== "task.create") {
          const current = yield* attemptSync(() => task(board, command.taskId));
          const latest = current.attempts.at(-1);
          if (latest) yield* assertIdle(latest.threadId);
        }
        if (command.type === "task.launch") {
          const current = yield* attemptSync(() => task(board, command.taskId));
          yield* attemptSync(() => {
            requireScope(board, command.actorWorkspaceId, current.assignedWorkspaceId);
            if (current.stage !== "ready")
              reject("invalid", "Task must be ready before starting. Record a retry reason first.");
            if (
              board.handoffs.some((item) => item.taskId === current.id && item.state === "offered")
            )
              reject("busy", "Resolve the pending handoff first.");
            if (current.attempts.length >= 64)
              reject("invalid", "Attempt limit reached for this task.");
            requireDependencies(board, current);
            const campaign = board.workspaces.find((item) =>
              item.coordination?.taskIds.includes(current.id),
            )?.coordination;
            if (
              campaign &&
              (!campaign.approved || campaign.phase !== "running" || current.attempts.length >= 2)
            )
              reject(
                "invalid",
                "Confirm or resume the team plan before launching; each task allows two attempts.",
              );
          });
          yield* project(current.assignedWorkspaceId, board);
          if (current.deliveryId) yield* verifyDelivery(board, current.deliveryId);
          for (const id of current.dependsOn) {
            const predecessor = task(board, id);
            if (predecessor.deliveryId) yield* verifyDelivery(board, predecessor.deliveryId);
          }
          const inputId = inputDeliveryId(board, current);
          const inputDelivery = board.deliveries.find((item) => item.id === inputId);
          const inputShell = inputDelivery ? yield* assertIdle(inputDelivery.threadId) : null;
          if (inputShell?.worktreePath) {
            for (const other of board.tasks.filter(
              (item) => item.stage === "working" && item.id !== current.id,
            )) {
              const otherInput = board.deliveries.find(
                (item) => item.id === inputDeliveryId(board, other),
              );
              const otherShell = otherInput
                ? yield* projections.getThreadShell(otherInput.threadId)
                : null;
              if (otherShell?.worktreePath === inputShell.worktreePath)
                return yield* new TeamWorkError({
                  code: "busy",
                  message:
                    "Another team holds this delivery checkout. Capture its work before continuing.",
                });
            }
          }
          const briefing = yield* attemptSync(() => makeBriefing(board, current));
          board = replaceTask(board, {
            ...current,
            stage: "working",
            attempts: [
              ...current.attempts,
              {
                id: command.commandId,
                threadId: ThreadId.make(`team-${command.commandId}`),
                workspaceId: current.assignedWorkspaceId,
                team: current.team,
                generation: current.generation,
                briefing,
                createdAt: now,
                launchState: "pending",
                modelSelection: command.modelSelection,
                baseRef: command.baseRef,
                inputDeliveryIds: [
                  ...new Set([
                    ...(current.deliveryId ? [current.deliveryId] : []),
                    ...current.dependsOn.flatMap((id) => {
                      const predecessor = task(board, id);
                      return predecessor.deliveryId ? [predecessor.deliveryId] : [];
                    }),
                  ]),
                ],
              },
            ],
          });
        } else if (command.type === "task.deliver") {
          const current = yield* attemptSync(() => task(board, command.taskId));
          yield* attemptSync(() =>
            requireScope(board, command.actorWorkspaceId, current.assignedWorkspaceId),
          );
          const source = yield* attemptSync(() => {
            const latest = current.attempts.at(-1);
            if (
              current.stage !== "working" ||
              !latest ||
              latest.id !== command.attemptId ||
              latest.generation !== current.generation
            )
              reject("conflict", "Only the current execution may submit a delivery.");
            if (
              command.paths.length === 0 ||
              command.paths.length > 16 ||
              new Set(command.paths).size !== command.paths.length
            )
              reject("invalid", "Submit between one and sixteen unique artifact paths.");
            return latest;
          });
          const shell = yield* assertIdle(source.threadId);
          if (!shell || !["completed", "failed", "interrupted", "cancelled"].includes(shell.status))
            return yield* new TeamWorkError({
              code: "invalid",
              message: "A stopped T3 execution is required before preserving its files.",
            });
          const sourceProject = yield* project(source.workspaceId, board);
          const captures = yield* Effect.forEach(command.paths, (path) =>
            io(() => readArtifact(shell.worktreePath ?? sourceProject.workspaceRoot, path)),
          );
          if (captures.reduce((total, item) => total + item.bytes, 0) > 2 * 1024 * 1024)
            return yield* new TeamWorkError({
              code: "invalid",
              message: "Delivery artifacts exceed 2 MiB.",
            });
          const artifacts = captures.map((capture, index) => ({
            id: `${command.commandId}-${index}`,
            path: capture.path,
            digest: capture.digest,
            bytes: capture.bytes,
          }));
          for (let index = 0; index < captures.length; index++) {
            const capture = captures[index]!;
            yield* sql`INSERT INTO team_work_artifacts (artifact_id, digest, body) VALUES (${artifacts[index]!.id}, ${capture.digest}, ${capture.base64})`;
          }
          board = {
            ...replaceTask(board, { ...current, deliveryId: command.commandId, stage: "review" }),
            deliveries: [
              ...board.deliveries,
              {
                id: command.commandId,
                taskId: current.id,
                attemptId: source.id,
                threadId: source.threadId,
                generation: current.generation,
                summary: command.summary,
                executionStatus: shell.status as
                  | "completed"
                  | "failed"
                  | "interrupted"
                  | "cancelled",
                artifacts,
                checks: command.checks,
                remaining: command.remaining,
                createdAt: now,
              },
            ],
          };
        } else {
          if (command.type === "handoff.respond" && command.accept) {
            const handoff = board.handoffs.find((item) => item.id === command.handoffId);
            if (handoff) yield* verifyDelivery(board, handoff.deliveryId);
          }
          if (command.type === "delivery.accept") yield* verifyDelivery(board, command.deliveryId);
          board = yield* attemptSync(() => applyPlanning(board, command, now));
        }
        board = { ...board, revision: board.revision + 1 };
        yield* persist(board, command.commandId, stringify(intent));
        yield* sql`INSERT INTO team_work_commands (command_id, fingerprint, revision) VALUES (${command.commandId}, ${fingerprint}, ${board.revision})`;
        return board;
      }),
    );
  });

  const execute = Effect.fn("TeamWorkService.execute")(function* (command: TeamWorkCommand) {
    const committed = yield* lock.withPermit(commit(command));
    if (command.type === "workspace.coordinate") {
      if (command.action !== "pause" && command.action !== "reset")
        yield* dispatchOwner(command.workspaceId);
      return yield* load();
    }
    if (command.type !== "task.launch") return committed;
    const current = yield* attemptSync(() => task(committed, command.taskId));
    const attempt = current.attempts.find((item) => item.id === command.commandId);
    if (!attempt || attempt.launchState === "started") return committed;
    const target = yield* project(attempt.workspaceId, committed);
    const delivery = committed.deliveries.find(
      (item) => item.id === inputDeliveryId(committed, current),
    );
    const priorShell = delivery ? yield* assertIdle(delivery.threadId) : null;
    const sameProject =
      priorShell?.projectId === target.projectId && priorShell.worktreePath !== null;
    if (sameProject) {
      for (const other of committed.tasks) {
        const latest = other.attempts.at(-1);
        if (!latest || latest.id === attempt.id) continue;
        const shell = yield* projections.getThreadShell(latest.threadId);
        if (shell?.worktreePath === priorShell.worktreePath) yield* assertIdle(latest.threadId);
      }
    }
    if (sameProject && delivery) {
      for (const artifact of delivery.artifacts) {
        const live = yield* io(() => readArtifact(priorShell.worktreePath!, artifact.path));
        if (live.digest !== artifact.digest)
          return yield* new TeamWorkError({
            code: "conflict",
            message:
              "The source checkout changed after delivery. Restore or submit its current version before continuing.",
          });
      }
    }
    const launched = yield* Effect.result(
      launcher.launch({
        commandId: CommandId.make(`team-${command.commandId}`),
        threadId: attempt.threadId,
        projectId: target.projectId,
        title: current.title,
        modelSelection: command.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: sameProject
          ? { type: "existing_worktree", worktreePath: priorShell.worktreePath! }
          : { type: "worktree", baseRef: command.baseRef },
        initialMessage: { text: attempt.briefing, attachments: [] },
        createdBy: "user",
        creationSource: "web",
      }),
    );
    const updated = yield* lock.withPermit(
      sql.withTransaction(
        Effect.gen(function* () {
          const board = yield* load();
          const latest = task(board, command.taskId);
          if (latest.generation !== attempt.generation) return board;
          const launchState =
            launched._tag === "Success" ? ("started" as const) : ("unknown" as const);
          const next = {
            ...replaceTask(board, {
              ...latest,
              attempts: latest.attempts.map((item) =>
                item.id === attempt.id ? { ...item, launchState } : item,
              ),
            }),
            revision: board.revision + 1,
          };
          yield* persist(
            next,
            `${command.commandId}-launch-${next.revision}`,
            stringify({ type: "launch.observed", attemptId: attempt.id, launchState }),
          );
          return next;
        }),
      ),
    );
    if (launched._tag === "Failure")
      return yield* new TeamWorkError({
        code: "unavailable",
        message:
          "T3 could not confirm the launch. Inspect the linked thread; retry the same command to reconcile.",
      });
    return updated;
  });

  const list = Effect.gen(function* () {
    const board = yield* load();
    const executions = yield* Effect.forEach(
      board.tasks,
      (current) =>
        Effect.gen(function* () {
          const attempt = current.attempts.at(-1);
          if (!attempt) return [];
          const result = yield* Effect.result(projections.getThreadShell(attempt.threadId));
          const shell = result._tag === "Success" ? result.success : null;
          return [
            {
              taskId: current.id,
              attemptId: attempt.id,
              threadId: attempt.threadId,
              status: shell?.pendingRuntimeRequest
                ? shell.pendingRuntimeRequest.kind === "user_input"
                  ? "waiting_input"
                  : "waiting_approval"
                : (shell?.status ?? "unknown"),
              active: shell
                ? !terminal.has(shell.status) ||
                  shell.activeRunId !== null ||
                  shell.pendingRuntimeRequest !== null ||
                  (shell.pendingBackgroundTasks?.length ?? 0) > 0
                : false,
              observedAt: yield* nowIso,
            },
          ];
        }),
      { concurrency: 8 },
    );
    const owners = yield* Effect.forEach(
      board.workspaces.filter((item) => item.coordination && item.ownerThreadId),
      (scope) =>
        Effect.gen(function* () {
          const shell = yield* projections.getThreadShell(scope.ownerThreadId!);
          return {
            workspaceId: scope.id,
            status: shell?.pendingRuntimeRequest
              ? shell.pendingRuntimeRequest.kind === "user_input"
                ? "waiting_input"
                : "waiting_approval"
              : (shell?.status ?? "unknown"),
            active: shell
              ? !terminal.has(shell.status) ||
                shell.activeRunId !== null ||
                shell.pendingRuntimeRequest !== null ||
                (shell.pendingBackgroundTasks?.length ?? 0) > 0
              : false,
          };
        }),
      { concurrency: 8 },
    );
    return { board, executions: executions.flat(), owners };
  });

  const knowledge = Effect.fn("TeamWorkService.knowledge")(function* (
    input: typeof TeamKnowledgeInput.Type,
  ) {
    const board = yield* load();
    const target = yield* project(input.workspaceId, board);
    return yield* io(() => readKnowledge(target.workspaceRoot));
  });

  const execution = Effect.fn("TeamWorkService.execution")(function* (
    input: typeof TeamExecutionInput.Type,
  ) {
    const view = yield* list;
    const current = yield* attemptSync(() => task(view.board, input.taskId));
    const attempt = current.attempts.at(-1);
    const observed = view.executions.find((item) => item.taskId === current.id);
    if (!attempt || !observed)
      return {
        threadId: null,
        checkoutRoot: null,
        status: "unstarted",
        active: false,
        finalText: "",
      };
    const sourceShell = yield* projections.getThreadShell(attempt.threadId);
    const sourceProject = yield* project(attempt.workspaceId, view.board);
    const checkoutRoot = sourceShell?.worktreePath ?? sourceProject.workspaceRoot;
    if (observed.active || observed.status === "unknown")
      return {
        threadId: attempt.threadId,
        checkoutRoot,
        status: observed.status,
        active: observed.active,
        finalText: "",
      };
    const shell = yield* assertIdle(attempt.threadId);
    const records = yield* projections.getThreadRecords(attempt.threadId, ["messages"], {
      messageRoles: ["assistant"],
      ...(shell?.latestRunId ? { messageRunIds: [shell.latestRunId] } : {}),
    });
    return {
      threadId: attempt.threadId,
      checkoutRoot,
      status: observed.status,
      active: false,
      finalText: records.messages
        .filter((item) => !item.streaming)
        .map((item) => item.text)
        .join("\n\n")
        .slice(-24_000),
    };
  });

  const updateCoordination = Effect.fn("TeamWorkService.updateCoordination")(function* (
    workspaceId: string,
    update: (scope: TeamBoard["workspaces"][number]) => TeamBoard["workspaces"][number],
  ) {
    return yield* lock.withPermit(
      sql.withTransaction(
        Effect.gen(function* () {
          const board = yield* load();
          const next = {
            ...board,
            revision: board.revision + 1,
            workspaces: board.workspaces.map((item) =>
              item.id === workspaceId ? update(item) : item,
            ),
          };
          yield* persist(
            next,
            `coord-${workspaceId}-${next.revision}`,
            stringify({ type: "coordination.observed", workspaceId }),
          );
          return next;
        }),
      ),
    );
  });

  const dispatchOwner = Effect.fn("TeamWorkService.dispatchOwner")(function* (workspaceId: string) {
    yield* ownerLock.withPermit(
      Effect.gen(function* () {
        const board = yield* load();
        const scope = workspace(board, workspaceId);
        const coordination = scope.coordination;
        if (!coordination?.pending || !scope.ownerThreadId || coordination.phase === "paused")
          return;
        const target = yield* project(workspaceId, board);
        const text = ownerBriefing(board, scope);
        const messageId = MessageId.make(`owner-message-${coordination.dispatchId}`);
        if (scope.ownerThreadId === `owner-${coordination.dispatchId}`)
          yield* launcher.launch({
            commandId: CommandId.make(`owner-${coordination.dispatchId}`),
            threadId: scope.ownerThreadId,
            projectId: target.projectId,
            title: `Owner · ${scope.title}`,
            modelSelection: coordination.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { text, messageId, attachments: [] },
            createdBy: "user",
            creationSource: "server",
          });
        else
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`owner-follow-${coordination.dispatchId}`),
            threadId: scope.ownerThreadId,
            messageId,
            text,
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
            dispatchMode: { type: "start_immediately" },
          });
        yield* updateCoordination(workspaceId, (current) =>
          current.coordination?.dispatchId === coordination.dispatchId
            ? { ...current, coordination: { ...current.coordination, pending: false } }
            : current,
        );
      }),
    );
  });

  const reconcile = Effect.gen(function* () {
    const initial = yield* load();
    for (const scope of initial.workspaces) {
      const coordination = scope.coordination;
      if (!coordination || coordination.phase === "paused" || coordination.phase === "review")
        continue;
      if (coordination.pending) {
        yield* dispatchOwner(scope.id);
        continue;
      }
      if (!coordination.approved || !scope.ownerThreadId) continue;
      const owner = yield* projections.getThreadShell(scope.ownerThreadId);
      if (
        !owner ||
        !terminal.has(owner.status) ||
        owner.activeRunId ||
        owner.pendingRuntimeRequest ||
        (owner.pendingBackgroundTasks?.length ?? 0) > 0
      )
        continue;
      const view = yield* list;
      const current = workspace(view.board, scope.id).coordination;
      if (!current || current.phase !== "running") continue;
      const planned = current.taskIds.map((id) => task(view.board, id));
      if (
        planned.some(
          (item) => view.executions.find((execution) => execution.taskId === item.id)?.active,
        )
      )
        continue;
      const review = planned.every(
        (item) => item.deliveryId !== null && ["review", "done"].includes(item.stage),
      );
      const blocked = planned.some((item) => ["blocked", "cancelled"].includes(item.stage));
      yield* updateCoordination(scope.id, (workspace) =>
        workspace.coordination?.phase !== "running" ||
        workspace.coordination.dispatchId !== current.dispatchId
          ? workspace
          : {
              ...workspace,
              coordination: {
                ...workspace.coordination!,
                phase: review ? "review" : blocked || current.turns >= 12 ? "paused" : "running",
                turns: current.turns + 1,
                dispatchId: `wake-${scope.id}-${view.board.revision}`,
                pending: !review && !blocked && current.turns < 12,
                note: review
                  ? "团队交付已汇总，请检查产物并验收。"
                  : blocked
                    ? "有任务阻塞，需要处理后继续。"
                    : current.turns >= 12
                      ? "本轮调度已达到上限，请检查后继续。"
                      : "",
              },
            },
      );
      if (!review && !blocked && current.turns < 12) yield* dispatchOwner(scope.id);
    }
  });

  const exportVault = Effect.fn("TeamWorkService.exportVault")(function* (input: TeamExportInput) {
    const board = yield* load();
    const target = yield* project(input.workspaceId, board);
    const currentTasks = board.tasks.filter((item) =>
      canInclude(board, input.workspaceId, item.workspaceId),
    );
    const md = (value: unknown) =>
      `\n\n\`\`\`json\n${JSON.stringify(value, null, 2).replaceAll("`", "\\u0060")}\n\`\`\`\n`;
    const files: Array<readonly [string, string | Buffer]> = [
      [
        "index.md",
        `# ${workspace(board, input.workspaceId).title}\n\n${workspace(board, input.workspaceId).objective}\n\nGenerated from task revision ${board.revision}. Task state is managed in the workbench; these files are a snapshot.\n\n${currentTasks.map((item) => `- [[task-${item.id}|${item.title.replaceAll("|", " ").replaceAll("]", " ")}]]: ${item.stage}`).join("\n")}`,
      ],
    ];
    for (const current of currentTasks) {
      files.push([
        `task-${current.id}.md`,
        `# Task\n\n${current.deliveryId ? `[[delivery-${current.deliveryId}|Current delivery]]` : "No delivery yet"}\n\n${current.handoffId ? `[[handoff-${current.handoffId}|Handoff]]` : ""}${md(current)}`,
      ]);
      for (const delivery of board.deliveries.filter((item) => item.taskId === current.id)) {
        files.push([
          `delivery-${delivery.id}.md`,
          `# Delivery\n\n[[task-${current.id}|Task]]\n\n${delivery.artifacts.map((item) => `- [${item.path.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${artifactExportName(item.digest, item.path)})`).join("\n")}${md(delivery)}`,
        ]);
        for (const artifactRef of delivery.artifacts) {
          const saved = yield* artifact({ artifactId: artifactRef.id });
          files.push([
            artifactExportName(artifactRef.digest, artifactRef.path),
            Buffer.from(saved.base64, "base64"),
          ]);
        }
      }
      for (const handoff of board.handoffs.filter((item) => item.taskId === current.id))
        files.push([
          `handoff-${handoff.id}.md`,
          `# Handoff\n\n[[task-${current.id}|Task]] · [[delivery-${handoff.deliveryId}|Pinned delivery]]${md(handoff)}`,
        ]);
    }
    const directory = yield* io(() => writeVault(target.workspaceRoot, board.revision, files));
    return { directory, revision: board.revision };
  });
  return TeamWorkService.of({
    list: list.pipe(Effect.mapError(error)),
    reconcile: reconcile.pipe(Effect.mapError(error)),
    execution: (input) => execution(input).pipe(Effect.mapError(error)),
    knowledge: (input) => knowledge(input).pipe(Effect.mapError(error)),
    execute: (command) => execute(command).pipe(Effect.mapError(error)),
    artifact: (input) => artifact(input).pipe(Effect.mapError(error)),
    exportVault: (input) => exportVault(input).pipe(Effect.mapError(error)),
  });
});

function canInclude(board: TeamBoard, parent: string, child: string) {
  let current: string | null = child;
  while (current !== null) {
    if (current === parent) return true;
    current = board.workspaces.find((item) => item.id === current)?.parentId ?? null;
  }
  return false;
}

export const layer = Layer.effect(TeamWorkService, make);
