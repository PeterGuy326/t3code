import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  environment: vi.fn(),
  baseUrl: vi.fn(),
  copy: vi.fn(),
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironment: mocks.environment,
  useEnvironmentHttpBaseUrl: mocks.baseUrl,
}));
vi.mock(import("../../hooks/useCopyToClipboard"), () => ({
  writeTextToClipboard: mocks.copy,
}));

import { QwenWorkConnection } from "./QwenWorkConnection";

const environmentId = EnvironmentId.make("qwen-test");
function setup() {
  mocks.copy.mockReset().mockResolvedValue(true);
  mocks.baseUrl.mockReset().mockReturnValue("https://selected.example.test");
  mocks.environment.mockReset().mockReturnValue({
    entry: {
      target: {
        _tag: "PrimaryConnectionTarget",
        environmentId,
        label: "Selected",
        httpBaseUrl: "https://selected.example.test/?credential=not-for-sharing",
        wsBaseUrl: "wss://selected.example.test",
      },
      profile: { _tag: "None" },
      enabled: true,
    },
  });
}
function click(text: string) {
  return act(async () => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === text,
    );
    expect(button).toBeDefined();
    button!.click();
  });
}
const connection = () => (
  <QwenWorkConnection environmentId={environmentId} workspaceId="goal-a" title="预约功能" />
);

describe("QwenWork connection", () => {
  it("copies the selected environment address without connection credentials", async () => {
    setup();
    await using screen = await render(connection());
    await click("千问办公");
    await click("复制连接配置");
    expect(JSON.parse(mocks.copy.mock.calls.at(-1)![0])).toEqual({
      mcpServers: {
        "t3-teamwork": { url: "https://selected.example.test/mcp", authType: "oauth" },
      },
    });
    await expect.element(screen.getByRole("status")).toHaveTextContent("已复制连接配置");
    await click("复制接棒指令");
    const briefing = mocks.copy.mock.calls.at(-1)![0];
    expect(briefing).toContain("goal-a");
    expect(briefing).toContain("team_work_artifact");
    expect(briefing).toContain("不要根据摘要重新生成");
    await act(async () => document.querySelector("summary")!.click());
    await click("复制连接地址");
    expect(mocks.copy).toHaveBeenLastCalledWith("https://selected.example.test/mcp", "连接地址");
  });

  it("keeps a failed copy retryable instead of reporting a connected client", async () => {
    setup();
    mocks.copy.mockRejectedValue(new Error("unavailable"));
    await using screen = await render(connection());
    await click("千问办公");
    await click("复制连接配置");
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("复制失败，请展开连接信息手动复制。");
    mocks.copy.mockResolvedValue(true);
    await click("复制连接配置");
    await expect.element(screen.getByRole("status")).toHaveTextContent("已复制连接配置");
  });
});
