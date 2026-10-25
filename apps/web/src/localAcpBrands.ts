import hermesIcon from "./assets/providers/hermes.svg?url";
import qoderIcon from "./assets/providers/qoder.svg?url";
import qwenWorkIcon from "./assets/providers/qwenwork.svg?url";
import workBuddyIcon from "./assets/providers/workbuddy.png?url";

// Product marks from NousResearch/hermes-agent's favicon, Qoder's installed
// brand assets, qwenwork.cn/app/favicon.svg, and the WorkBuddy open platform's
// favicon. Bundle them for offline use.
const brands = {
  hermes: { label: "Hermes", icon: hermesIcon },
  qoder: { label: "Qoder", icon: qoderIcon },
  qwenwork: { label: "千问办公", icon: qwenWorkIcon },
  workbuddy: { label: "WorkBuddy", icon: workBuddyIcon },
} as const;

export function localAcpAgentId(commandPath: unknown): keyof typeof brands | undefined {
  if (typeof commandPath !== "string") return undefined;
  const executable = commandPath
    .trim()
    .split(/[\\/]/u)
    .at(-1)
    ?.replace(/\.(exe|cmd)$/iu, "");
  if (/^hermes(?:-acp)?$/iu.test(executable ?? "")) return "hermes";
  if (/^qoder(?:cli)?$/iu.test(executable ?? "")) return "qoder";
  if (/^qwenwork(?:-acp|cn)?$/iu.test(executable ?? "")) return "qwenwork";
  if (/^workbuddy$/iu.test(executable ?? "")) return "workbuddy";
  return undefined;
}

export function localAcpBrand(agentId: string | undefined, displayName: string) {
  const id = localAcpAgentId(agentId) ?? localAcpAgentId(displayName.replace(/ CLI$/iu, ""));
  return id ? brands[id] : displayName === "千问办公" ? brands.qwenwork : undefined;
}
