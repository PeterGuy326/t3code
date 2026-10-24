import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { LayersIcon, RefreshCwIcon } from "lucide-react";
import {
  type EnvironmentId,
  type TeamBoard,
  type TeamTask,
  type TeamWorkCommand,
} from "@t3tools/contracts";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import {
  teamWorkExecute,
  teamWorkExport,
  teamWorkList,
  teamWorkArtifact,
} from "../../state/teamWork";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";

const stages: Record<TeamTask["stage"], string> = {
  ready: "可开始",
  working: "进行中",
  blocked: "阻塞",
  review: "待验收 / 接棒",
  done: "已验收",
  cancelled: "已取消",
};
const executionLabels: Record<string, string> = {
  preparing: "准备中",
  queued: "排队中",
  starting: "启动中",
  running: "执行中",
  waiting: "等待中",
  waiting_input: "等待回复",
  waiting_approval: "等待审批",
  completed: "本次执行完成",
  interrupted: "已中断",
  cancelled: "已取消",
  failed: "执行失败",
  unknown: "状态未知",
  idle: "空闲",
  rolled_back: "已回退",
};
const lines = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
const value = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const selectClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="text-muted-foreground">{title}</span>
      {children}
    </label>
  );
}

export function TeamWorkPage() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = environments.find((item) => item.environmentId === (chosen ?? primary));
  return (
    <SidebarInset>
      <WorkspacePageHeader>
        <LayersIcon className="size-4" />
        <h1 className="text-sm font-medium">目标与团队</h1>
      </WorkspacePageHeader>
      <div className="flex-1 overflow-auto scrollbar-gutter-both p-5 md:p-8">
        <div className="mx-auto grid max-w-7xl gap-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xl font-semibold">一个目标，多条工作线。</p>
              <p className="mt-1 text-sm text-muted-foreground">
                每个工作区一个 owner。父工作区协调子工作区，团队围绕产物接棒。
              </p>
            </div>
            <Field title="执行环境">
              <select
                className={selectClass}
                aria-label="执行环境"
                value={selected?.environmentId ?? ""}
                onChange={(event) => setChosen(event.target.value)}
              >
                <option value="" disabled>
                  选择环境
                </option>
                {environments.map((item) => (
                  <option key={item.environmentId} value={item.environmentId}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {selected ? (
            <WorkspaceBoard key={selected.environmentId} environmentId={selected.environmentId} />
          ) : (
            <p role="status">所选环境不可用。请连接环境后继续。</p>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function WorkspaceBoard({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(teamWorkList({ environmentId, input: {} }));
  const execute = useAtomCommand(teamWorkExecute, { reportFailure: false });
  const exportVault = useAtomCommand(teamWorkExport, { reportFailure: false });
  const canOperate = useAtomValue(teamWorkExecute.permissionAtom(environmentId));
  const canExport = useAtomValue(teamWorkExport.permissionAtom(environmentId));
  const projects = useProjects().filter((item) => item.environmentId === environmentId);
  const ownerThreads = useThreadShells().filter(
    (item) => item.environmentId === environmentId && !item.id.startsWith("team-"),
  );
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const [scopeId, setScopeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const refresh = query.refresh;
  useEffect(() => {
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  const board = query.data?.board;
  const selected =
    board?.workspaces.find((item) => item.id === scopeId) ??
    (scopeId ? null : board?.workspaces[0]);
  const actorWorkspaceId = selected?.id ?? "";
  const descendants = new Set<string>(selected ? [selected.id] : []);
  if (board)
    for (let index = 0; index < board.workspaces.length; index++)
      for (const item of board.workspaces)
        if (item.parentId && descendants.has(item.parentId)) descendants.add(item.id);
  const tasks =
    board?.tasks.filter(
      (item) => descendants.has(item.workspaceId) || descendants.has(item.assignedWorkspaceId),
    ) ?? [];

  async function submit(command: TeamWorkCommand, form?: HTMLFormElement) {
    setBusy(true);
    setError("");
    setMessage("");
    const result = await execute({ environmentId, input: command });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause));
      refresh();
      return;
    }
    form?.reset();
    refresh();
    setMessage("已保存。");
  }
  function metadata() {
    return { commandId: randomUUID(), expectedRevision: board?.revision ?? 0 };
  }
  function formSubmit(
    event: FormEvent<HTMLFormElement>,
    build: (form: FormData) => TeamWorkCommand,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    void submit(build(new FormData(form)), form);
  }
  if (!board)
    return (
      <div role="status">
        {query.error ?? "正在读取目标与团队…"}
        <Button variant="outline" onClick={refresh}>
          重试
        </Button>
      </div>
    );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {board.workspaces.length} 个工作区 ·{" "}
          {tasks.filter((item) => item.stage === "working").length} 项推进中 ·{" "}
          {tasks.filter((item) => item.stage === "review").length} 项待接收
        </p>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCwIcon />
          刷新
        </Button>
      </div>
      {(error || query.error) && (
        <p role="alert" className="rounded-lg border border-destructive p-3 text-sm">
          {error || query.error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          {message}
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="grid content-start gap-4">
          <div className="rounded-xl border bg-card p-4">
            <h2 className="mb-3 font-medium">工作区与 owner</h2>
            <div className="grid gap-2">
              {board.workspaces.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={item.id === selected?.id}
                  className={`rounded-lg border p-3 text-left ${item.id === selected?.id ? "border-primary bg-accent" : "border-transparent hover:bg-accent"}`}
                  onClick={() => setScopeId(item.id)}
                >
                  <span className="block font-medium">{item.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {item.owner} ·{" "}
                    {item.parentId
                      ? `上级：${board.workspaces.find((parent) => parent.id === item.parentId)?.title}`
                      : "总体目标"}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <details className="rounded-xl border p-4" open={board.workspaces.length === 0}>
            <summary className="cursor-pointer text-sm font-medium">创建工作区</summary>
            <form
              className="mt-4 grid gap-3"
              onSubmit={(event) =>
                formSubmit(event, (form) => ({
                  ...metadata(),
                  type: "workspace.create",
                  workspace: {
                    id: randomUUID(),
                    projectId: projects.find((item) => item.id === value(form, "project"))!.id,
                    parentId: value(form, "parent") || null,
                    title: value(form, "title"),
                    objective: value(form, "objective"),
                    owner: value(form, "owner"),
                  },
                }))
              }
            >
              <Field title="T3 项目">
                <select required name="project" className={selectClass}>
                  <option value="">选择项目</option>
                  {projects
                    .filter(
                      (item) => !board.workspaces.some((scope) => scope.projectId === item.id),
                    )
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                </select>
              </Field>
              <Field title="工作区名称">
                <Input required name="title" />
              </Field>
              <Field title="Owner">
                <Input required name="owner" />
              </Field>
              <Field title="总体目标">
                <Textarea required name="objective" />
              </Field>
              <Field title="父工作区">
                <select name="parent" className={selectClass} defaultValue={selected?.id ?? ""}>
                  <option value="">独立工作区</option>
                  {board.workspaces.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" disabled={busy || !canOperate}>
                创建工作区
              </Button>
            </form>
          </details>
        </aside>
        <section className="grid min-w-0 content-start gap-4">
          {selected ? (
            <>
              <div className="rounded-xl border bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold">{selected.title}</h2>
                  <Badge variant="secondary">Owner · {selected.owner}</Badge>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm">{selected.objective}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !canExport}
                    onClick={() => {
                      setBusy(true);
                      void exportVault({ environmentId, input: { workspaceId: selected.id } }).then(
                        (result) => {
                          setBusy(false);
                          if (result._tag === "Success")
                            setMessage(`已导出 Obsidian 快照：${result.value.directory}`);
                          else setError(formatEnvironmentQueryError(result.cause));
                        },
                      );
                    }}
                  >
                    导出到 Obsidian
                  </Button>
                </div>
                <details className="mt-4 text-sm">
                  <summary className="cursor-pointer text-muted-foreground">
                    修改 owner 与目标
                  </summary>
                  <form
                    key={selected.id}
                    className="mt-3 grid gap-3"
                    onSubmit={(event) =>
                      formSubmit(event, (form) => ({
                        ...metadata(),
                        type: "workspace.update",
                        workspaceId: selected.id,
                        owner: value(form, "owner"),
                        objective: value(form, "objective"),
                        ownerThreadId:
                          ownerThreads.find((item) => item.id === value(form, "ownerThread"))?.id ??
                          null,
                      }))
                    }
                  >
                    <Field title="Owner">
                      <Input required name="owner" defaultValue={selected.owner} />
                    </Field>
                    <Field title="目标">
                      <Textarea required name="objective" defaultValue={selected.objective} />
                    </Field>
                    <Field title="Owner 的 AI 会话（可选）">
                      <select
                        name="ownerThread"
                        className={selectClass}
                        defaultValue={selected.ownerThreadId ?? ""}
                      >
                        <option value="">由我手动调度</option>
                        {ownerThreads
                          .filter((item) => item.projectId === selected.projectId)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.title}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <Button type="submit" disabled={busy || !canOperate}>
                      保存目标
                    </Button>
                  </form>
                </details>
              </div>
              <details className="rounded-xl border p-4">
                <summary className="cursor-pointer font-medium">分派任务</summary>
                <form
                  className="mt-4 grid gap-3 md:grid-cols-2"
                  onSubmit={(event) =>
                    formSubmit(event, (form) => ({
                      ...metadata(),
                      type: "task.create",
                      actorWorkspaceId,
                      taskId: randomUUID(),
                      workspaceId: value(form, "workspace"),
                      title: value(form, "title"),
                      requirement: value(form, "requirement"),
                      criteria: lines(form.get("criteria")),
                      team: value(form, "team"),
                      dependsOn: form.getAll("dependencies").map(String),
                    }))
                  }
                >
                  <Field title="交给工作区">
                    <select name="workspace" className={selectClass}>
                      {board.workspaces
                        .filter((item) => descendants.has(item.id))
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title} · {item.owner}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field title="负责团队">
                    <Input required name="team" placeholder="例如：实现团队" />
                  </Field>
                  <Field title="任务名称">
                    <Input required name="title" />
                  </Field>
                  <Field title="工作要求">
                    <Textarea required name="requirement" />
                  </Field>
                  <Field title="验收条件（每行一条）">
                    <Textarea required name="criteria" />
                  </Field>
                  <Field title="前序任务（可多选）">
                    <select name="dependencies" multiple className={selectClass}>
                      {tasks.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div>
                    <Button type="submit" disabled={busy || !canOperate}>
                      分派任务
                    </Button>
                  </div>
                </form>
              </details>
              {tasks.length === 0 && (
                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                  先分派一个任务。不同任务可以并行推进同一目标。
                </div>
              )}
              {tasks.map((current) => {
                const execution = query.data?.executions.find((item) => item.taskId === current.id);
                const latest = current.attempts.at(-1);
                const delivery = board.deliveries.find((item) => item.id === current.deliveryId);
                const pending = board.handoffs.find(
                  (item) => item.taskId === current.id && item.state === "offered",
                );
                const assigned = board.workspaces.find(
                  (item) => item.id === current.assignedWorkspaceId,
                );
                return (
                  <article key={current.id} className="min-w-0 rounded-xl border bg-card p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-medium">{current.title}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {assigned?.title} · {current.team} · 第 {current.generation + 1} 轮分工
                        </p>
                      </div>
                      <Badge
                        variant={
                          current.stage === "done"
                            ? "success"
                            : current.stage === "blocked"
                              ? "warning"
                              : "secondary"
                        }
                      >
                        {stages[current.stage]}
                      </Badge>
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm">{current.requirement}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      {execution ? (
                        <>
                          <span>执行：{executionLabels[execution.status] ?? execution.status}</span>
                          <Link
                            to="/$environmentId/$threadId"
                            params={{ environmentId, threadId: execution.threadId }}
                            className="underline"
                          >
                            打开原始会话
                          </Link>
                        </>
                      ) : (
                        <span>尚未执行</span>
                      )}
                      {delivery && <span>交付：{delivery.artifacts.length} 份固定版本产物</span>}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setExpanded(expanded === current.id ? null : current.id)}
                      >
                        {expanded === current.id ? "收起" : "任务、产物与接棒"}
                      </Button>
                    </div>
                    {expanded === current.id && (
                      <div className="mt-5 grid gap-5 border-t pt-5">
                        <div>
                          <p className="mb-2 text-sm font-medium">验收条件</p>
                          <ul className="list-inside list-disc text-sm text-muted-foreground">
                            {current.criteria.map((criterion) => (
                              <li key={criterion}>{criterion}</li>
                            ))}
                          </ul>
                        </div>
                        {current.dependsOn.length > 0 && (
                          <p className="text-sm">
                            前序：
                            {current.dependsOn
                              .map((id) => board.tasks.find((item) => item.id === id)?.title)
                              .join("、")}
                          </p>
                        )}
                        {current.stage === "ready" && (
                          <form
                            className="grid gap-3 md:grid-cols-3"
                            onSubmit={(event) =>
                              formSubmit(event, (form) => {
                                const [instance, model] = value(form, "model").split("\t");
                                const provider = providers.find(
                                  (item) => item.instanceId === instance,
                                )!;
                                return {
                                  ...metadata(),
                                  type: "task.launch",
                                  actorWorkspaceId,
                                  taskId: current.id,
                                  baseRef: value(form, "baseRef"),
                                  modelSelection: {
                                    instanceId: provider.instanceId,
                                    model: model!,
                                  },
                                };
                              })
                            }
                          >
                            <Field title="执行 Agent 与模型">
                              <select required name="model" className={selectClass}>
                                <option value="">选择已连接的 Agent</option>
                                {providers
                                  .filter(
                                    (item) =>
                                      item.enabled &&
                                      item.installed &&
                                      item.status !== "error" &&
                                      (item.supportedRuntimeModes?.includes("approval-required") ??
                                        true),
                                  )
                                  .flatMap((provider) =>
                                    provider.models.map((model) => (
                                      <option
                                        key={`${provider.instanceId}:${model.slug}`}
                                        value={`${provider.instanceId}\t${model.slug}`}
                                      >
                                        {provider.instanceId} · {model.name}
                                      </option>
                                    )),
                                  )}
                              </select>
                            </Field>
                            <Field title="新工作区的基础分支">
                              <Input required name="baseRef" defaultValue="HEAD" />
                            </Field>
                            <div className="flex items-end">
                              <Button type="submit" disabled={busy || !canOperate}>
                                启动任务
                              </Button>
                            </div>
                          </form>
                        )}
                        {latest &&
                          latest.launchState !== "started" &&
                          current.stage === "working" && (
                            <Button
                              variant="outline"
                              disabled={busy || !canOperate}
                              onClick={() =>
                                void submit({
                                  commandId: latest.id,
                                  expectedRevision: board.revision,
                                  type: "task.launch",
                                  actorWorkspaceId,
                                  taskId: current.id,
                                  modelSelection: latest.modelSelection,
                                  baseRef: latest.baseRef,
                                })
                              }
                            >
                              核对并重试原启动请求
                            </Button>
                          )}
                        {current.stage === "working" &&
                          execution !== undefined &&
                          ["completed", "failed", "interrupted", "cancelled"].includes(
                            execution.status,
                          ) &&
                          latest && (
                            <form
                              className="grid gap-3"
                              onSubmit={(event) =>
                                formSubmit(event, (form) => ({
                                  ...metadata(),
                                  type: "task.deliver",
                                  actorWorkspaceId,
                                  taskId: current.id,
                                  attemptId: latest.id,
                                  summary: value(form, "summary"),
                                  paths: lines(form.get("paths")),
                                  checks: lines(form.get("checks")),
                                  remaining: lines(form.get("remaining")),
                                }))
                              }
                            >
                              <Field title="交付说明">
                                <Textarea required name="summary" />
                              </Field>
                              <Field title="产物相对路径（每行一个）">
                                <Textarea required name="paths" placeholder="src/login.ts" />
                              </Field>
                              <Field title="实际验证与结果（每行一条）">
                                <Textarea name="checks" />
                              </Field>
                              <Field title="未完成事项（每行一条）">
                                <Textarea name="remaining" />
                              </Field>
                              <div>
                                <Button type="submit" disabled={busy || !canOperate}>
                                  固定产物并提交交付
                                </Button>
                              </div>
                            </form>
                          )}
                        {delivery && (
                          <DeliveryView
                            environmentId={environmentId}
                            delivery={delivery}
                            board={board}
                          />
                        )}
                        {current.stage === "review" && !pending && (
                          <>
                            <form
                              className="grid gap-3 md:grid-cols-2"
                              onSubmit={(event) =>
                                formSubmit(event, (form) => ({
                                  ...metadata(),
                                  type: "handoff.offer",
                                  actorWorkspaceId,
                                  taskId: current.id,
                                  toWorkspaceId: value(form, "target"),
                                  toTeam: value(form, "team"),
                                  nextSteps: value(form, "next"),
                                }))
                              }
                            >
                              <Field title="接棒工作区">
                                <select
                                  name="target"
                                  className={selectClass}
                                  defaultValue={current.assignedWorkspaceId}
                                >
                                  {board.workspaces
                                    .filter((item) => descendants.has(item.id))
                                    .map((item) => (
                                      <option key={item.id} value={item.id}>
                                        {item.title}
                                      </option>
                                    ))}
                                </select>
                              </Field>
                              <Field title="接棒团队">
                                <Input required name="team" />
                              </Field>
                              <Field title="从哪里继续、避免重做什么">
                                <Textarea required name="next" />
                              </Field>
                              <div className="flex items-end">
                                <Button
                                  type="submit"
                                  variant="outline"
                                  disabled={busy || !canOperate}
                                >
                                  发起接棒
                                </Button>
                              </div>
                            </form>
                            <form
                              className="grid gap-3 rounded-lg border p-4"
                              onSubmit={(event) =>
                                formSubmit(event, (form) => ({
                                  ...metadata(),
                                  type: "delivery.accept",
                                  actorWorkspaceId,
                                  taskId: current.id,
                                  deliveryId: delivery!.id,
                                  accepted: value(form, "verdict") === "accept",
                                  criteriaConfirmed: current.criteria.map((_, index) =>
                                    form.has(`criterion-${index}`),
                                  ),
                                  reason: value(form, "reason"),
                                }))
                              }
                            >
                              <p className="text-sm font-medium">人工验收当前交付</p>
                              {current.criteria.map((criterion, index) => (
                                <label key={criterion} className="flex gap-2 text-sm">
                                  <input type="checkbox" name={`criterion-${index}`} />
                                  {criterion}
                                </label>
                              ))}
                              <Field title="验收意见">
                                <Input required name="reason" />
                              </Field>
                              <select name="verdict" className={selectClass}>
                                <option value="reject">需要继续完善</option>
                                <option value="accept">验收通过</option>
                              </select>
                              <div>
                                <Button type="submit" disabled={busy || !canOperate}>
                                  记录验收
                                </Button>
                              </div>
                            </form>
                          </>
                        )}
                        {pending && (
                          <div className="grid gap-3 rounded-lg border p-4">
                            <p className="text-sm font-medium">等待 {pending.toTeam} 接棒</p>
                            <p className="whitespace-pre-wrap text-sm">{pending.nextSteps}</p>
                            <form
                              className="grid gap-3"
                              onSubmit={(event) =>
                                formSubmit(event, (form) => ({
                                  ...metadata(),
                                  type: "handoff.respond",
                                  actorWorkspaceId,
                                  handoffId: pending.id,
                                  accept: value(form, "decision") === "accept",
                                  receipt: value(form, "receipt"),
                                }))
                              }
                            >
                              <Field title="接收回执：已拿到哪些产物、下一步是什么">
                                <Textarea required name="receipt" />
                              </Field>
                              <select name="decision" className={selectClass}>
                                <option value="accept">确认接收</option>
                                <option value="reject">拒绝接收</option>
                              </select>
                              <div className="flex gap-2">
                                <Button type="submit" disabled={busy || !canOperate}>
                                  提交回执
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={busy || !canOperate}
                                  onClick={() =>
                                    void submit({
                                      ...metadata(),
                                      type: "handoff.revoke",
                                      actorWorkspaceId,
                                      handoffId: pending.id,
                                    })
                                  }
                                >
                                  撤销交接
                                </Button>
                              </div>
                            </form>
                          </div>
                        )}
                        {!execution?.active && !pending && (
                          <form
                            className="flex flex-wrap items-end gap-3"
                            onSubmit={(event) =>
                              formSubmit(event, (form) => ({
                                ...metadata(),
                                type: "task.stage",
                                actorWorkspaceId,
                                taskId: current.id,
                                stage: value(form, "stage") as "ready" | "blocked" | "cancelled",
                                reason: value(form, "reason"),
                              }))
                            }
                          >
                            <Field title="调整阶段">
                              <select name="stage" className={selectClass}>
                                <option value="ready">可开始 / 重试</option>
                                <option value="blocked">阻塞</option>
                                <option value="cancelled">取消</option>
                              </select>
                            </Field>
                            <Field title="原因">
                              <Input required name="reason" />
                            </Field>
                            <Button type="submit" variant="outline" disabled={busy || !canOperate}>
                              更新
                            </Button>
                          </form>
                        )}
                        {current.attempts.length > 0 && (
                          <details>
                            <summary className="cursor-pointer text-sm font-medium">
                              执行与交付历史
                            </summary>
                            <div className="mt-3 grid gap-3">
                              {current.attempts.map((attempt) => (
                                <div key={attempt.id} className="rounded-lg border p-3 text-xs">
                                  <p>
                                    {attempt.team} · {attempt.modelSelection.instanceId} ·{" "}
                                    {attempt.modelSelection.model}
                                  </p>
                                  <p className="mt-1 text-muted-foreground">
                                    {attempt.createdAt} · 第 {attempt.generation + 1} 轮分工
                                  </p>
                                  <Link
                                    to="/$environmentId/$threadId"
                                    params={{ environmentId, threadId: attempt.threadId }}
                                    className="mt-2 inline-block underline"
                                  >
                                    查看这次执行
                                  </Link>
                                </div>
                              ))}
                              {board.deliveries
                                .filter(
                                  (item) =>
                                    item.taskId === current.id && item.id !== current.deliveryId,
                                )
                                .map((item) => (
                                  <DeliveryView
                                    key={item.id}
                                    environmentId={environmentId}
                                    delivery={item}
                                    board={board}
                                  />
                                ))}
                            </div>
                          </details>
                        )}
                        {current.attempts.length > 0 && (
                          <details>
                            <summary className="cursor-pointer text-sm text-muted-foreground">
                              执行时实际交给 Agent 的简报
                            </summary>
                            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">
                              {latest?.briefing}
                            </pre>
                          </details>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </>
          ) : (
            <div className="rounded-xl border border-dashed p-8">
              <p className="font-medium">从一个总体目标开始</p>
              <p className="mt-2 text-sm text-muted-foreground">
                先在 T3 添加项目，再将它注册为工作区，指定 owner 和目标。
              </p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function DeliveryView({
  environmentId,
  delivery,
  board,
}: {
  environmentId: EnvironmentId;
  delivery: TeamBoard["deliveries"][number];
  board: TeamBoard;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <div className="grid gap-2 rounded-lg border p-4">
      <h4 className="text-sm font-medium">固定交付版本</h4>
      {delivery.executionStatus && (
        <p className="text-xs text-muted-foreground">
          来源执行：{executionLabels[delivery.executionStatus]}。是否完成任务由验收决定。
        </p>
      )}
      <p className="whitespace-pre-wrap text-sm">{delivery.summary}</p>
      <ul className="grid gap-2">
        {delivery.artifacts.map((artifact) => (
          <li key={artifact.id} className="break-all text-xs">
            <button
              type="button"
              className="font-medium underline"
              onClick={() => setPreview(preview === artifact.id ? null : artifact.id)}
            >
              {artifact.path}
            </button>{" "}
            · {artifact.bytes} bytes
            <br />
            <span className="text-muted-foreground">SHA-256 {artifact.digest}</span>
          </li>
        ))}
      </ul>
      {preview && <ArtifactPreview environmentId={environmentId} artifactId={preview} />}
      <p className="text-xs text-muted-foreground">
        验证记录：{delivery.checks.join("；") || "未提供"}
      </p>
      <p className="text-xs text-muted-foreground">
        待续事项：{delivery.remaining.join("；") || "未记录"}
      </p>
      {board.handoffs
        .filter((item) => item.deliveryId === delivery.id)
        .map((item) => (
          <p key={item.id} className="text-xs text-muted-foreground">
            接棒：{item.toTeam} · {item.state}
            {item.receipt ? ` · ${item.receipt}` : ""}
          </p>
        ))}
    </div>
  );
}

function ArtifactPreview({
  environmentId,
  artifactId,
}: {
  environmentId: EnvironmentId;
  artifactId: string;
}) {
  const query = useEnvironmentQuery(teamWorkArtifact({ environmentId, input: { artifactId } }));
  if (!query.data)
    return (
      <p role="status" className="text-xs">
        {query.error ?? "正在读取固定版本…"}
      </p>
    );
  const { artifact, base64 } = query.data;
  const bytes = Uint8Array.from(atob(base64), (item) => item.charCodeAt(0));
  const text = bytes.includes(0)
    ? "此产物为二进制文件，请下载查看。"
    : new TextDecoder().decode(bytes);
  return (
    <div className="grid gap-2">
      <a
        className="text-xs underline"
        download={artifact.path.split("/").at(-1)}
        href={`data:application/octet-stream;base64,${base64}`}
      >
        下载这个固定版本
      </a>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">
        {text}
      </pre>
    </div>
  );
}
