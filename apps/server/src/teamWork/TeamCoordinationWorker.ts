import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as TeamWork from "./TeamWorkService.ts";

export const start = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const service = yield* TeamWork.TeamWorkService;
  const reconcile = service.reconcile.pipe(
    Effect.catch((cause) => Effect.logWarning("team coordination needs attention", { cause })),
  );
  yield* forkParked(
    Effect.gen(function* () {
      yield* reconcile;
      yield* Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "checkpoint.captured" ||
        event.type === "run.background-work-cancelled" ||
        ((event.type === "run.updated" ||
          event.type === "run-attempt.updated" ||
          event.type === "turn-item.updated" ||
          event.type === "context-transfer.updated") &&
          ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status))
          ? reconcile
          : Effect.void,
      );
    }),
  );
});
