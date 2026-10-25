import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TeamWork from "../../../teamWork/TeamWorkService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { TeamWorkToolkit } from "./tools.ts";

const failure = (cause: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message });
export const layer = McpToolAccess.toLayer(TeamWorkToolkit, {
  team_work_execution: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* TeamWork.TeamWorkService)
        .execution(input)
        .pipe(Effect.mapError(failure));
    }),
  ),
  team_work_knowledge: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* TeamWork.TeamWorkService)
        .knowledge(input)
        .pipe(Effect.mapError(failure));
    }),
  ),
  team_work_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* TeamWork.TeamWorkService).list.pipe(Effect.mapError(failure));
    }),
  ),
  team_work_artifact: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* TeamWork.TeamWorkService)
        .artifact(input)
        .pipe(Effect.mapError(failure));
    }),
  ),
  team_work_update: McpToolAccess.writes(({ command: input }) =>
    Effect.gen(function* () {
      const caller = yield* readCaller();
      if (
        input.type === "delivery.accept" ||
        input.type === "workspace.create" ||
        input.type === "workspace.update" ||
        input.type === "workspace.coordinate"
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Workspace configuration and human acceptance are workbench actions.",
        });
      }
      const service = yield* TeamWork.TeamWorkService;
      if (caller.caller) {
        const { board } = yield* service.list.pipe(Effect.mapError(failure));
        const ownerScope = board.workspaces.find(
          (item) => item.ownerThreadId === caller.caller!.id,
        );
        const ownTask = board.tasks.find(
          (item) => item.attempts.at(-1)?.threadId === caller.caller!.id,
        );
        const attempt = ownTask?.attempts.at(-1);
        const scope =
          ownerScope?.id ??
          (attempt?.generation === ownTask?.generation ? attempt?.workspaceId : undefined);
        if (
          scope !== input.actorWorkspaceId ||
          ((input.type === "task.create" || input.type === "task.launch") && !ownerScope)
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "Only the bound workspace owner may schedule work. Use its assigned workspace scope.",
          });
        if (!ownerScope && "taskId" in input && input.taskId !== ownTask?.id)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "A worker may update only its current task.",
          });
        if (
          !ownerScope &&
          "handoffId" in input &&
          board.handoffs.find((item) => item.id === input.handoffId)?.taskId !== ownTask?.id
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "A worker may respond only to its own task's handoff.",
          });
      }
      return yield* service.execute(input).pipe(Effect.mapError(failure));
    }),
  ),
});
