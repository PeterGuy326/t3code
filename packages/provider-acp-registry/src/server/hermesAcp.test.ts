import { describe, expect, it } from "vite-plus/test";
import { hermesAcpFatalError } from "./hermesAcp.ts";

describe("Hermes ACP inference failures", () => {
  it("reports an aborted model request instead of an empty successful turn", () => {
    const error = hermesAcpFatalError("Non-retryable client error (HTTP 401). Aborting.");
    expect(error?.errorMessage).toContain("Hermes model request failed");
    expect(error?.method).toBe("session/prompt");
  });
  it("allows warnings and a fallback that may still succeed", () => {
    expect(
      hermesAcpFatalError("Non-retryable error (HTTP 401) — trying fallback..."),
    ).toBeUndefined();
    expect(hermesAcpFatalError("Starting hermes-agent ACP adapter")).toBeUndefined();
  });
  it("never copies stderr credentials into a transport error", () => {
    const error = hermesAcpFatalError(
      "secret-token Non-retryable client error (HTTP 403). Aborting.",
    );
    expect(error?.errorMessage).not.toContain("secret-token");
  });
});
