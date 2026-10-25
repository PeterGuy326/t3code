// A catalog entry is selectable only when T3 can launch its execution protocol.
// A desktop installation or an inbound MCP connection does not provide one.
export const agentProviderChoices = [
  { id: "hermes", label: "Hermes", launch: { commandPath: "hermes", commandArgs: ["acp"] } },
  { id: "qoder", label: "Qoder", launch: { commandPath: "qodercli", commandArgs: ["--acp"] } },
  { id: "qwenwork", label: "千问办公", launch: null },
  { id: "workbuddy", label: "WorkBuddy", launch: null },
] as const;

export type AgentProviderChoice = (typeof agentProviderChoices)[number];
