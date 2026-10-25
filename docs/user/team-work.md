# Work toward a goal with AI teams

Open **目标与团队** in the sidebar. Add your repositories as ordinary T3 projects first, then register a workspace for each project with one owner and a clear objective. A parent workspace represents a broader goal. It can assign work to itself or its descendants; siblings cannot schedule one another.

Create independent tasks for work that can run in parallel. Each task has a responsible team, requirements, acceptance criteria and optional predecessor tasks. Start it with one of the environment's available agents. T3 continues to own providers, authentication, approvals, threads and execution. New tasks use separate Git worktrees, so the project needs an initial commit.

To let an AI owner coordinate the work, create a normal T3 conversation in the workspace's project and bind it under **修改 owner 与目标 → Owner 的 AI 会话**. The owner can use `team_work_list` and `team_work_update` to dispatch and launch descendant tasks. A worker cannot impersonate another workspace owner. An unbound workspace stays under manual coordination. Reporting relationships do not grant filesystem access or change provider permissions.

## Submit files and hand work over

A completed agent execution leaves the task in progress until its delivery is submitted. Open **任务、产物与接棒**, enter the produced files' paths relative to that execution's checkout, and record checks and remaining work. Submit only after its agent and background work have stopped. Failed, interrupted and cancelled executions can also preserve their partial files for a successor; their real execution status stays on the delivery. Saving a partial result never marks its execution successful.

A delivery stores the actual file bytes, their SHA-256 digests and their original task and execution identities. The first version supports up to 16 files, 512 KiB per file and 2 MiB per delivery. These are selected-file snapshots, not a backup of the entire repository. Use the artifact name to inspect or download its fixed version even after the source file changes.

Choose a receiving workspace and team, and describe where to continue. Offering a handoff does not transfer responsibility. The receiver records a receipt; accepting checks the saved artifacts and source execution before changing the assignment. Rejection and withdrawal preserve the original delivery. Retired managed task conversations cannot start new agent turns.

For continuation in the same T3 project, the next agent uses the previous worktree after the submitted files have been checked against their saved versions. If those files changed, continuation stops rather than silently switching versions. Across projects, the receiver starts in its own worktree and retrieves the saved files through `team_work_artifact`; it does not inherit another project's working directory or credentials. A later delivery preserves the earlier versions.

Human acceptance applies to one specific delivery and requires every criterion to be confirmed. Agent completion and handoff acceptance do not complete the task. A retry keeps history, records a reason and creates a new execution attempt. Predecessors need a current accepted delivery before dependent work starts.

## Read the work in Obsidian

Choose **导出到 Obsidian** to write a revision snapshot under the selected project's `notes/teamwork-generated/`. Open `notes/` as an Obsidian vault. The export links tasks, deliveries, handoffs and copies of their exact file versions. Exporting the parent includes descendant task records.

The workbench owns task and execution status. Editing an exported Markdown file does not start an agent or complete a task. Exports use revision directories; edited snapshots are preserved and reported as conflicts. Existing personal notes remain separate. Obsidian and community plugins are optional.

## Use Hermes and Qoder teams

In **Settings → Providers → Add instance**, choose **Hermes CLI** or **Qoder CLI**. These use the installed CLI through ACP: `hermes acp` or `qodercli --acp`. The executable and arguments are editable. Qoder installations that expose the CLI as `qoder` can use that executable instead; the Qoder IDE launcher is a different program. Each instance keeps its own identity, discovered models and approval requests.

Select the environment where the CLI is installed and signed in. For Windows clients using Linux installations, enable the distro under **Settings → Connections → WSL backend**, then add the providers in that WSL environment. The Windows installer includes a Linux runtime, so its backend does not depend on the version of Node selected in your shell. The distro, Git and the agent CLIs must already be installed.

Hermes uses its own model configuration and credentials. An empty response from older Hermes releases is reported as a failed execution, rather than a successful delivery. If you want a separate Hermes profile, set `HERMES_HOME` in that provider instance's environment variables and configure the model in that profile. No credentials are bundled with the installer.

The personal desktop distribution uses `~/.t3-teamwork` on each operating system and its own Chromium profile. It can be installed alongside the original T3. An explicit `T3CODE_HOME` still selects a different Windows backend directory.

This version adds the workbench to the web client and the desktop client that wraps it. Native mobile keeps its existing T3 features. RoleWeave workspace migration, legacy CLI history import, cross-device scheduling, automatic delivery discovery and per-provider budget enforcement are not included yet.
