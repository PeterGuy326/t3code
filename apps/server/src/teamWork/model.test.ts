import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ThreadId, type TeamBoard, type TeamTask } from "@t3tools/contracts";
import {
  applyPlanning,
  canSchedule,
  emptyBoard,
  makeBriefing,
  requireDependencies,
} from "./model.ts";
import { isCurrentTeamThread } from "./admission.ts";

const now = "2026-10-25T00:00:00.000Z";
const meta = { commandId: "command", expectedRevision: 0 };
function organization(): TeamBoard {
  let board = emptyBoard();
  for (const [id, parentId] of [
    ["company", null],
    ["product", "company"],
    ["research", "company"],
    ["client", "product"],
    ["other", null],
  ] as const) {
    board = applyPlanning(
      board,
      {
        ...meta,
        type: "workspace.create",
        workspace: {
          id,
          parentId,
          projectId: ProjectId.make(id),
          title: id,
          objective: `Goal ${id}`,
          owner: `Owner ${id}`,
        },
      },
      now,
    );
  }
  return board;
}
function planned(board: TeamBoard, id = "implementation", dependsOn: string[] = []): TeamBoard {
  return applyPlanning(
    board,
    {
      ...meta,
      type: "task.create",
      taskId: id,
      actorWorkspaceId: "company",
      workspaceId: "product",
      title: id,
      requirement: "Continue the implementation",
      criteria: ["Existing work is retained"],
      team: "Codex team",
      dependsOn,
    },
    now,
  );
}
function delivered(): TeamBoard {
  const board = planned(organization());
  return {
    ...board,
    tasks: board.tasks.map((item) => ({ ...item, stage: "review", deliveryId: "delivery" })),
    deliveries: [
      {
        id: "delivery",
        taskId: "implementation",
        attemptId: "attempt",
        threadId: ThreadId.make("thread"),
        generation: 0,
        summary: "Implemented",
        artifacts: [{ id: "artifact", path: "result.md", digest: "fixed-digest", bytes: 42 }],
        checks: ["Checks passed"],
        remaining: ["Review"],
        createdAt: now,
      },
    ],
  };
}

describe("workspace scheduling and artifact handoffs", () => {
  it("allows a parent to coordinate descendants without permitting siblings or unrelated roots", () => {
    const board = organization();
    expect(canSchedule(board, "company", "client")).toBe(true);
    expect(canSchedule(board, "product", "client")).toBe(true);
    expect(canSchedule(board, "research", "product")).toBe(false);
    expect(canSchedule(board, "other", "client")).toBe(false);
    expect(() =>
      applyPlanning(
        board,
        {
          ...meta,
          type: "task.create",
          actorWorkspaceId: "research",
          workspaceId: "product",
          taskId: "wrong",
          title: "Wrong",
          requirement: "Wrong",
          criteria: ["done"],
          team: "team",
          dependsOn: [],
        },
        now,
      ),
    ).toThrow("ancestor");
  });
  it("keeps independent tasks in the same goal rather than replacing one active task", () => {
    const board = planned(planned(organization()), "review");
    expect(board.tasks.map((item) => item.id)).toEqual(["implementation", "review"]);
    expect(board.tasks.every((item) => item.workspaceId === "product")).toBe(true);
  });
  it("requires a real accepted predecessor delivery instead of a successful turn or done label", () => {
    let board = planned(delivered(), "downstream", ["implementation"]);
    expect(() => requireDependencies(board, board.tasks[1]!)).toThrow("accepted delivery");
    board = applyPlanning(
      board,
      {
        ...meta,
        type: "delivery.accept",
        actorWorkspaceId: "company",
        taskId: "implementation",
        deliveryId: "delivery",
        accepted: true,
        criteriaConfirmed: [true],
        reason: "Verified file",
      },
      now,
    );
    expect(() => requireDependencies(board, board.tasks[1]!)).not.toThrow();
    const changed = {
      ...board,
      tasks: board.tasks.map((item) =>
        item.id === "implementation" ? { ...item, deliveryId: "new-delivery" } : item,
      ),
    };
    expect(() => requireDependencies(changed, changed.tasks[1]!)).toThrow("accepted delivery");
  });
  it("does not transfer ownership until the receiving team accepts the pinned delivery", () => {
    const board = delivered();
    const offered = applyPlanning(
      board,
      {
        ...meta,
        commandId: "handoff",
        type: "handoff.offer",
        actorWorkspaceId: "company",
        taskId: "implementation",
        toWorkspaceId: "client",
        toTeam: "Hermes reviewers",
        nextSteps: "Read result.md and review it; do not rebuild it.",
      },
      now,
    );
    expect(offered.tasks[0]!.assignedWorkspaceId).toBe("product");
    const accepted = applyPlanning(
      offered,
      {
        ...meta,
        type: "handoff.respond",
        actorWorkspaceId: "client",
        handoffId: "handoff",
        accept: true,
        receipt: "Received result.md; reviewing it.",
      },
      now,
    );
    expect(accepted.tasks[0]).toMatchObject({
      id: "implementation",
      workspaceId: "product",
      assignedWorkspaceId: "client",
      generation: 1,
      team: "Hermes reviewers",
      stage: "ready",
    });
    expect(accepted.deliveries).toEqual(board.deliveries);
    expect(makeBriefing(accepted, accepted.tasks[0]!)).toContain("fixed-digest");
    expect(makeBriefing(accepted, accepted.tasks[0]!)).toContain("Read result.md");
  });
  it("allows rejecting or revoking a handoff without moving work or dropping its artifacts", () => {
    const board = applyPlanning(
      delivered(),
      {
        ...meta,
        commandId: "handoff",
        type: "handoff.offer",
        actorWorkspaceId: "company",
        taskId: "implementation",
        toWorkspaceId: "product",
        toTeam: "reviewers",
        nextSteps: "Review",
      },
      now,
    );
    const rejected = applyPlanning(
      board,
      {
        ...meta,
        type: "handoff.respond",
        actorWorkspaceId: "product",
        handoffId: "handoff",
        accept: false,
        receipt: "Need test evidence",
      },
      now,
    );
    expect(rejected.tasks[0]!.generation).toBe(0);
    expect(rejected.handoffs[0]!.state).toBe("rejected");
    const revoked = applyPlanning(
      board,
      { ...meta, type: "handoff.revoke", actorWorkspaceId: "company", handoffId: "handoff" },
      now,
    );
    expect(revoked.handoffs[0]!.state).toBe("revoked");
    expect(revoked.deliveries).toEqual(board.deliveries);
  });
  it("rejects stale acceptance, incomplete criteria and a changed handoff source", () => {
    const board = delivered();
    expect(() =>
      applyPlanning(
        board,
        {
          ...meta,
          type: "delivery.accept",
          actorWorkspaceId: "company",
          taskId: "implementation",
          deliveryId: "older",
          accepted: true,
          criteriaConfirmed: [true],
          reason: "yes",
        },
        now,
      ),
    ).toThrow("current delivery");
    expect(() =>
      applyPlanning(
        board,
        {
          ...meta,
          type: "delivery.accept",
          actorWorkspaceId: "company",
          taskId: "implementation",
          deliveryId: "delivery",
          accepted: true,
          criteriaConfirmed: [],
          reason: "yes",
        },
        now,
      ),
    ).toThrow("every acceptance criterion");
    const offered = applyPlanning(
      board,
      {
        ...meta,
        commandId: "handoff",
        type: "handoff.offer",
        actorWorkspaceId: "company",
        taskId: "implementation",
        toWorkspaceId: "product",
        toTeam: "review",
        nextSteps: "Review",
      },
      now,
    );
    const changed = {
      ...offered,
      tasks: offered.tasks.map((item) => ({ ...item, generation: 2 })),
    };
    expect(() =>
      applyPlanning(
        changed,
        {
          ...meta,
          type: "handoff.respond",
          actorWorkspaceId: "product",
          handoffId: "handoff",
          accept: true,
          receipt: "yes",
        },
        now,
      ),
    ).toThrow("changed");
  });
  it("blocks retired sessions while allowing the current attempt and ordinary T3 threads", () => {
    const board = planned(organization());
    const base = {
      workspaceId: "product",
      team: "team",
      briefing: "briefing",
      createdAt: now,
      launchState: "started" as const,
      modelSelection: {
        instanceId: "codex" as TeamTask["attempts"][number]["modelSelection"]["instanceId"],
        model: "test",
      },
      baseRef: "HEAD",
    };
    const active: TeamBoard = {
      ...board,
      tasks: board.tasks.map((item) => ({
        ...item,
        stage: "working",
        generation: 1,
        attempts: [
          { ...base, id: "old", threadId: ThreadId.make("team-old"), generation: 0 },
          { ...base, id: "new", threadId: ThreadId.make("team-new"), generation: 1 },
        ],
      })),
    };
    expect(isCurrentTeamThread(active, "team-old")).toBe(false);
    expect(isCurrentTeamThread(active, "team-new")).toBe(true);
    expect(isCurrentTeamThread(active, "team-unknown")).toBe(false);
    expect(isCurrentTeamThread(active, "ordinary-thread")).toBe(true);
    expect(
      isCurrentTeamThread(
        { ...active, tasks: active.tasks.map((item) => ({ ...item, stage: "review" })) },
        "team-new",
      ),
    ).toBe(false);
  });
});
