import { TeamBoard, TeamWorkError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
const decodeBoard = Schema.decodeEffect(Schema.fromJsonString(TeamBoard));

export function isCurrentTeamThread(board: TeamBoard, threadId: string): boolean {
  const current = board.tasks.find((item) =>
    item.attempts.some((attempt) => attempt.threadId === threadId),
  );
  if (!current) return !threadId.startsWith("team-");
  const attempt = current.attempts.at(-1);
  return (
    current.stage === "working" &&
    attempt?.threadId === threadId &&
    attempt.generation === current.generation
  );
}

export class TeamWorkAdmission extends Context.Reference<
  (threadId: ThreadId) => Effect.Effect<void, TeamWorkError>
>("t3/teamWork/Admission", {
  defaultValue: () => (threadId) =>
    threadId.startsWith("team-")
      ? Effect.fail(
          new TeamWorkError({
            code: "unavailable",
            message: "Tracked-task admission is unavailable.",
          }),
        )
      : Effect.void,
}) {}

export const layer = Layer.effect(
  TeamWorkAdmission,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return Effect.fn("TeamWorkAdmission.check")(function* (threadId: ThreadId) {
      if (!threadId.startsWith("team-")) return;
      const rows = yield* sql<{ body: string }>`SELECT body FROM team_work_state WHERE id = 1`.pipe(
        Effect.mapError(
          () =>
            new TeamWorkError({
              code: "unavailable",
              message: "Task ownership could not be verified.",
            }),
        ),
      );
      const board = rows[0]
        ? yield* decodeBoard(rows[0].body).pipe(
            Effect.mapError(
              () =>
                new TeamWorkError({
                  code: "unavailable",
                  message: "Task ownership could not be decoded.",
                }),
            ),
          )
        : null;
      if (!board || !isCurrentTeamThread(board, threadId))
        return yield* new TeamWorkError({
          code: "conflict",
          message:
            "This execution no longer owns the task. Continue from its current assignment in the team workbench.",
        });
    });
  }),
);
