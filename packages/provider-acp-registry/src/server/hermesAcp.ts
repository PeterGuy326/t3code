import { AcpRequestError } from "effect-acp/errors";

// Older Hermes ACP releases return end_turn without a message after inference
// aborts. Only the final abort marker is fatal; fallback warnings are recoverable.
export function hermesAcpFatalError(stderr: string): AcpRequestError | undefined {
  if (!/Non-retryable client error[\s\S]{0,100}?Aborting\./u.test(stderr)) return;
  return new AcpRequestError({
    code: -32603,
    method: "session/prompt",
    errorMessage:
      "Hermes model request failed before producing a response. Check this instance's model provider and authentication configuration.",
  });
}
