import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE team_work_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, body TEXT NOT NULL)`;
  yield* sql`CREATE TABLE team_work_commands (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE team_work_events (revision INTEGER PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, created_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE team_work_artifacts (artifact_id TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL)`;
});
