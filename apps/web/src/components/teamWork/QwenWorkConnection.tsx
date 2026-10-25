import { useState } from "react";
import { ProviderDriverKind, type EnvironmentId } from "@t3tools/contracts";
import { environmentMcpUrl } from "@t3tools/client-runtime/connection";
import { useEnvironment, useEnvironmentHttpBaseUrl } from "../../state/environments";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

export function QwenWorkConnection({
  environmentId,
  workspaceId,
  title,
}: {
  environmentId: EnvironmentId;
  workspaceId: string;
  title: string;
}) {
  const environment = useEnvironment(environmentId);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const mcpUrl = environment
    ? environmentMcpUrl({ entry: environment.entry, relayHttpBaseUrl: httpBaseUrl ?? undefined })
    : null;
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const config = mcpUrl
    ? JSON.stringify({ mcpServers: { "t3-teamwork": { url: mcpUrl } } }, null, 2)
    : "";
  const briefing = `请通过 T3 Teamwork 连接器继续目标「${title}」（工作区 ${workspaceId}）。先调用 team_work_list 读取最新任务、状态、交接说明和交付版本。已有产物必须先通过 team_work_artifact 读取固定版本，核对 SHA-256 并复用，不要根据摘要重新生成。完成后报告使用了哪些产物、还需做什么；需要更新任务时先重新读取 revision，再用 team_work_update。验收是否通过由我在工作台确认。不要启动与本目标无关的任务。`;

  async function copy(text: string, label: string) {
    setMessage("");
    setError(false);
    try {
      await writeTextToClipboard(text, label);
      setMessage(`已复制${label}`);
    } catch {
      setError(true);
      setMessage("复制失败，请展开连接信息手动复制。");
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make("acpRegistry")}
          displayName="千问办公"
          iconClassName="size-4"
        />
        千问办公
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>让千问办公加入这个目标</DialogTitle>
            <DialogDescription>沿用千问办公账号，共享任务和已有产物。</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-4">
              <p className="text-sm">
                首次使用：在千问办公的「连接器」中添加自定义 MCP，粘贴连接地址并完成授权。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={!mcpUrl} onClick={() => void copy(mcpUrl!, "连接地址")}>
                  复制连接地址
                </Button>
                <Button variant="outline" onClick={() => void copy(briefing, "接棒指令")}>
                  复制接棒指令
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                连接后，把接棒指令发给千问办公即可。当前目标：{title}
              </p>
              {!mcpUrl && (
                <p role="alert" className="text-sm">
                  当前环境没有可供千问办公访问的地址。请先在连接设置中连接可访问的环境。
                </p>
              )}
              {message && (
                <p role={error ? "alert" : "status"} className="text-sm">
                  {message}
                </p>
              )}
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">连接信息</summary>
                <div className="mt-3 grid gap-3">
                  {mcpUrl && (
                    <>
                      <p className="break-all">{mcpUrl}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void copy(config, "连接配置")}
                      >
                        复制 JSON 配置
                      </Button>
                      <pre className="overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
                        {config}
                      </pre>
                    </>
                  )}
                  <p className="whitespace-pre-wrap text-xs">{briefing}</p>
                  <a
                    href="https://docs.qwenwork.cn/features/connectors"
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    千问办公连接器说明
                  </a>
                </div>
              </details>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
