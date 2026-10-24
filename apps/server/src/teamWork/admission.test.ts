import { expect, it } from "@effect/vitest";
import { RunId, TeamWorkError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ContextHandoff from "../orchestration-v2/ContextHandoffService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuth from "../provider/ProviderAuthService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as RunExecution from "../orchestration-v2/RunExecutionService.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProviderTurnStart from "../orchestration-v2/ProviderTurnStartService.ts";
import { TeamWorkAdmission } from "./admission.ts";

it.effect(
  "retains task admission after construction and refuses retired work before touching the provider",
  () =>
    Effect.gen(function* () {
      let projectionReads = 0;
      const service = yield* ProviderTurnStart.ProviderTurnStartServiceV2.pipe(
        Effect.provide(
          ProviderTurnStart.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(TeamWorkAdmission, () =>
                  Effect.fail(new TeamWorkError({ code: "conflict", message: "Retired attempt" })),
                ),
                Layer.mock(ContextHandoff.ContextHandoffServiceV2)({}),
                Layer.mock(EventSink.EventSinkV2)({}),
                IdAllocator.layer.pipe(Layer.provide(NodeCrypto.layer)),
                NodeServices.layer,
                ServerConfig.layerTest("/test", { prefix: "t3-team-admission-" }).pipe(
                  Layer.provide(NodeServices.layer),
                ),
                ServerSettings.layerTest(),
                Layer.mock(GitWorkflow.GitWorkflowService)({}),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(ProviderAuth.ProviderAuthService)({}),
                Layer.mock(ProjectionStore.ProjectionStoreV2)({
                  getTurnStartContext: () => {
                    projectionReads++;
                    return Effect.die("Provider must not be reached");
                  },
                }),
                Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
                Layer.mock(RunExecution.RunExecutionServiceV2)({}),
                Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
              ),
            ),
          ),
        ),
      );
      const result = yield* Effect.result(
        service.start({
          threadId: ThreadId.make("team-retired"),
          runId: RunId.make("retired-run"),
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.cause).toMatchObject({
          code: "conflict",
          message: "Retired attempt",
        });
      expect(projectionReads).toBe(0);
    }),
);
