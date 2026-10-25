import { describe, expect, it } from "vite-plus/test";
import { localAcpAgentId, localAcpBrand } from "./localAcpBrands";

describe("local ACP product branding", () => {
  it("keeps a renamed local CLI's identity across Windows and Linux paths", () => {
    expect(localAcpAgentId("C:\\Program Files\\Hermes\\hermes.exe")).toBe("hermes");
    expect(localAcpAgentId("/home/me/bin/qodercli")).toBe("qoder");
    expect(localAcpBrand(localAcpAgentId("/bin/hermes"), "Research team")?.label).toBe("Hermes");
  });

  it("does not brand unrelated commands by a substring", () => {
    expect(localAcpAgentId("/bin/not-hermes")).toBeUndefined();
    expect(localAcpAgentId(null)).toBeUndefined();
    expect(localAcpBrand(undefined, "Qoder competitor")).toBeUndefined();
  });

  it("provides bundled product marks for existing default names", () => {
    for (const label of ["Hermes", "Qoder CLI", "千问办公", "WorkBuddy"]) {
      expect(localAcpBrand(undefined, label)?.icon).toMatch(/\.(?:svg|png)(?:\?|$)/u);
    }
  });
});
