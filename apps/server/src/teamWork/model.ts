import {
  TeamWorkError,
  ThreadId,
  type TeamBoard,
  type TeamTask,
  type TeamWorkCommand,
} from "@t3tools/contracts";

export const emptyBoard = (): TeamBoard => ({
  revision: 0,
  workspaces: [],
  tasks: [],
  deliveries: [],
  handoffs: [],
  acceptances: [],
});

export function reject(code: TeamWorkError["code"], message: string): never {
  throw new TeamWorkError({ code, message });
}

export function workspace(board: TeamBoard, id: string) {
  return (
    board.workspaces.find((item) => item.id === id) ??
    reject("missing", "Workspace no longer exists.")
  );
}

export function task(board: TeamBoard, id: string) {
  return board.tasks.find((item) => item.id === id) ?? reject("missing", "Task no longer exists.");
}

export function canSchedule(board: TeamBoard, parentId: string, childId: string): boolean {
  const visited = new Set<string>();
  let current: string | null = childId;
  while (current !== null && !visited.has(current)) {
    if (current === parentId) return true;
    visited.add(current);
    current = board.workspaces.find((item) => item.id === current)?.parentId ?? null;
  }
  return false;
}

export function requireScope(board: TeamBoard, actorId: string, targetId: string) {
  workspace(board, actorId);
  workspace(board, targetId);
  if (!canSchedule(board, actorId, targetId))
    reject("invalid", "Only this workspace or an ancestor may schedule its work.");
}

export function replaceTask(board: TeamBoard, updated: TeamTask): TeamBoard {
  return { ...board, tasks: board.tasks.map((item) => (item.id === updated.id ? updated : item)) };
}

export function inputDeliveryId(board: TeamBoard, current: TeamTask) {
  return (
    current.deliveryId ??
    current.dependsOn
      .flatMap((id) => {
        const deliveryId = task(board, id).deliveryId;
        return deliveryId ? [deliveryId] : [];
      })
      .at(-1)
  );
}

export function requireDependencies(board: TeamBoard, current: TeamTask) {
  const coordination = board.workspaces.find((item) =>
    item.coordination?.taskIds.includes(current.id),
  )?.coordination;
  for (const id of current.dependsOn) {
    const predecessor = task(board, id);
    const campaignInput =
      coordination?.approved &&
      coordination.taskIds.includes(current.id) &&
      coordination.taskIds.includes(id) &&
      predecessor.stage === "review" &&
      board.deliveries.some(
        (item) => item.id === predecessor.deliveryId && item.executionStatus === "completed",
      );
    if (
      !campaignInput &&
      (predecessor.stage !== "done" ||
        predecessor.deliveryId === null ||
        !board.acceptances.some(
          (item) =>
            item.taskId === id && item.deliveryId === predecessor.deliveryId && item.accepted,
        ))
    ) {
      reject("invalid", "A predecessor needs an accepted delivery before this task can start.");
    }
  }
}

export function makeBriefing(board: TeamBoard, current: TeamTask): string {
  const scope = workspace(board, current.workspaceId);
  const handoff = board.handoffs.find(
    (item) => item.id === current.handoffId && item.state === "accepted",
  );
  const deliveryIds = new Set([
    ...(handoff ? [handoff.deliveryId] : []),
    ...current.dependsOn.flatMap((id) => {
      const deliveryId = task(board, id).deliveryId;
      return deliveryId ? [deliveryId] : [];
    }),
  ]);
  const payload = {
    taskId: current.id,
    generation: current.generation,
    workspaceObjective: scope.objective,
    owner: workspace(board, current.assignedWorkspaceId).owner,
    team: current.team,
    requirement: current.requirement,
    acceptanceCriteria: current.criteria,
    handoff: handoff ?? null,
    deliveries: board.deliveries.filter((item) => deliveryIds.has(item.id)),
  };
  const text = `Continue this tracked task in your CURRENT checkout (process working directory). Original project paths quoted in requirements are historical context: resolve their project-relative files in this checkout, never write into the original project root. Existing deliveries are inputs: inspect and reuse their artifacts before implementing. Retrieve immutable file bytes with team_work_artifact; explain any required rework. Report actual checks, checkout-relative file paths and remaining work in your final response, then end the turn. Do not submit a delivery from an active turn: the source must be stopped before the workbench can fix its file versions. A successful agent turn is not task acceptance.\n\n${JSON.stringify(payload, null, 2)}`;
  if (Buffer.byteLength(text) > 16_000)
    reject("invalid", "The required handoff is too large. Split the task before starting.");
  return text;
}

export function applyPlanning(board: TeamBoard, command: TeamWorkCommand, now: string): TeamBoard {
  switch (command.type) {
    case "workspace.coordinate": {
      const scope = workspace(board, command.workspaceId);
      const previous = scope.coordination;
      if (command.action === "reset") {
        if (previous && !["paused", "review"].includes(previous.phase))
          reject("invalid", "Pause coordination before ending this campaign.");
        return {
          ...board,
          workspaces: board.workspaces.map((item) => {
            if (item.id !== scope.id) return item;
            const { coordination: _coordination, ...rest } = item;
            return { ...rest, ownerThreadId: null };
          }),
        };
      }
      if (command.action === "plan" && (previous || !command.modelSelection))
        reject("invalid", "Choose an owner for a new team plan.");
      if (command.action !== "plan" && !previous) reject("invalid", "Generate a team plan first.");
      if (command.action === "start") {
        if (previous!.approved || previous!.taskIds.length === 0)
          reject("invalid", "Review a new, non-empty plan before starting.");
        for (const id of previous!.taskIds) {
          const planned = task(board, id);
          if (planned.stage !== "ready" || planned.attempts.length > 0)
            reject("invalid", "Every planned task must be ready and unstarted.");
        }
      }
      const coordination = previous
        ? {
            ...previous,
            phase:
              command.action === "pause"
                ? ("paused" as const)
                : command.action === "start" || previous.approved
                  ? ("running" as const)
                  : ("planning" as const),
            approved: previous.approved || command.action === "start",
            dispatchId: previous.pending ? previous.dispatchId : command.commandId,
            pending: command.action !== "pause",
            turns: command.action === "pause" ? previous.turns : 0,
            note: command.action === "pause" ? "已暂停调度；正在执行的任务可在会话中停止。" : "",
          }
        : {
            phase: "planning" as const,
            approved: false,
            modelSelection: command.modelSelection!,
            taskIds: [],
            turns: 0,
            dispatchId: command.commandId,
            pending: true,
            note: "",
          };
      return {
        ...board,
        workspaces: board.workspaces.map((item) =>
          item.id === scope.id
            ? {
                ...item,
                ownerThreadId:
                  command.action === "plan"
                    ? ThreadId.make(`owner-${command.commandId}`)
                    : scope.ownerThreadId,
                coordination,
              }
            : item,
        ),
      };
    }
    case "workspace.create": {
      if (board.workspaces.length >= 128) reject("invalid", "Workspace limit reached.");
      if (
        board.workspaces.some(
          (item) =>
            item.id === command.workspace.id || item.projectId === command.workspace.projectId,
        )
      )
        reject("conflict", "This workspace or project is already registered.");
      if (command.workspace.parentId !== null) workspace(board, command.workspace.parentId);
      return { ...board, workspaces: [...board.workspaces, command.workspace] };
    }
    case "workspace.update": {
      workspace(board, command.workspaceId);
      return {
        ...board,
        workspaces: board.workspaces.map((item) =>
          item.id === command.workspaceId
            ? {
                ...item,
                owner: command.owner,
                objective: command.objective,
                ...(command.ownerThreadId !== undefined
                  ? { ownerThreadId: command.ownerThreadId }
                  : {}),
              }
            : item,
        ),
      };
    }
    case "task.create": {
      requireScope(board, command.actorWorkspaceId, command.workspaceId);
      if (board.tasks.length >= 512) reject("invalid", "Task limit reached.");
      if (board.tasks.some((item) => item.id === command.taskId))
        reject("conflict", "Task identity already exists.");
      if (
        command.criteria.length === 0 ||
        new Set(command.criteria).size !== command.criteria.length ||
        new Set(command.dependsOn).size !== command.dependsOn.length
      )
        reject("invalid", "A task needs acceptance criteria and unique predecessors.");
      for (const id of command.dependsOn) {
        const predecessor = task(board, id);
        requireScope(board, command.actorWorkspaceId, predecessor.workspaceId);
      }
      const coordination = workspace(board, command.actorWorkspaceId).coordination;
      if (coordination && (coordination.phase !== "planning" || coordination.taskIds.length >= 8))
        reject("invalid", "The team plan is frozen or has reached eight tasks.");
      return {
        ...board,
        workspaces: coordination
          ? board.workspaces.map((item) =>
              item.id === command.actorWorkspaceId
                ? {
                    ...item,
                    coordination: {
                      ...coordination,
                      taskIds: [...coordination.taskIds, command.taskId],
                    },
                  }
                : item,
            )
          : board.workspaces,
        tasks: [
          ...board.tasks,
          {
            id: command.taskId,
            workspaceId: command.workspaceId,
            assignedWorkspaceId: command.workspaceId,
            title: command.title,
            requirement: command.requirement,
            criteria: command.criteria,
            team: command.team,
            dependsOn: command.dependsOn,
            stage: "ready",
            generation: 0,
            attempts: [],
            deliveryId: null,
            handoffId: null,
            note: "",
          },
        ],
      };
    }
    case "task.stage": {
      const current = task(board, command.taskId);
      requireScope(board, command.actorWorkspaceId, current.assignedWorkspaceId);
      if (board.handoffs.some((item) => item.taskId === current.id && item.state === "offered"))
        reject("busy", "Resolve the pending handoff first.");
      return replaceTask(board, { ...current, stage: command.stage, note: command.reason });
    }
    case "handoff.offer": {
      const current = task(board, command.taskId);
      requireScope(board, command.actorWorkspaceId, current.assignedWorkspaceId);
      requireScope(board, command.actorWorkspaceId, command.toWorkspaceId);
      if (current.stage !== "review" || current.deliveryId === null)
        reject("invalid", "Submit a delivery before handing work over.");
      if (board.handoffs.some((item) => item.taskId === current.id && item.state === "offered"))
        reject("busy", "This task already has a pending handoff.");
      const handoff = {
        id: command.commandId,
        taskId: current.id,
        deliveryId: current.deliveryId,
        fromWorkspaceId: current.assignedWorkspaceId,
        toWorkspaceId: command.toWorkspaceId,
        toTeam: command.toTeam,
        generation: current.generation,
        nextSteps: command.nextSteps,
        state: "offered" as const,
        receipt: null,
        createdAt: now,
      };
      return {
        ...replaceTask(board, { ...current, handoffId: handoff.id }),
        handoffs: [...board.handoffs, handoff],
      };
    }
    case "handoff.respond":
    case "handoff.revoke": {
      const handoff =
        board.handoffs.find((item) => item.id === command.handoffId) ??
        reject("missing", "Handoff no longer exists.");
      if (handoff.state !== "offered") reject("conflict", "Handoff has already been resolved.");
      const current = task(board, handoff.taskId);
      requireScope(
        board,
        command.actorWorkspaceId,
        command.type === "handoff.revoke" ? handoff.fromWorkspaceId : handoff.toWorkspaceId,
      );
      if (current.generation !== handoff.generation || current.deliveryId !== handoff.deliveryId)
        reject("conflict", "Delivery changed. Create a new handoff.");
      const accept = command.type === "handoff.respond" && command.accept;
      const updated = accept
        ? replaceTask(board, {
            ...current,
            assignedWorkspaceId: handoff.toWorkspaceId,
            team: handoff.toTeam,
            generation: current.generation + 1,
            stage: "ready",
            note: handoff.nextSteps,
          })
        : board;
      return {
        ...updated,
        handoffs: updated.handoffs.map((item) =>
          item.id === handoff.id
            ? {
                ...item,
                state:
                  command.type === "handoff.revoke" ? "revoked" : accept ? "accepted" : "rejected",
                receipt: command.type === "handoff.respond" ? command.receipt : null,
              }
            : item,
        ),
      };
    }
    case "delivery.accept": {
      const current = task(board, command.taskId);
      requireScope(board, command.actorWorkspaceId, current.workspaceId);
      if (current.stage !== "review" || current.deliveryId !== command.deliveryId)
        reject("conflict", "Review the current delivery before deciding.");
      if (board.handoffs.some((item) => item.taskId === current.id && item.state === "offered"))
        reject("busy", "Resolve the pending handoff before acceptance.");
      if (
        command.accepted &&
        (command.criteriaConfirmed.length !== current.criteria.length ||
          !command.criteriaConfirmed.every(Boolean))
      )
        reject("invalid", "Confirm every acceptance criterion.");
      return {
        ...replaceTask(board, {
          ...current,
          stage: command.accepted ? "done" : "review",
          note: command.reason,
        }),
        acceptances: [
          ...board.acceptances,
          {
            taskId: current.id,
            deliveryId: command.deliveryId,
            accepted: command.accepted,
            reason: command.reason,
            createdAt: now,
          },
        ],
      };
    }
    case "task.launch":
    case "task.deliver":
      return reject("invalid", "Execution commands require the runtime service.");
  }
}
