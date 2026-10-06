import type { ClaudeRuntimeHealth } from "../types";
import { HarnessPage } from "./HarnessPage";
import type { HarnessViewProps } from "./pageTypes";

export function ClaudeView({ runtimeHealth, ...props }: HarnessViewProps & { runtimeHealth: ClaudeRuntimeHealth | null }) {
  return (
    <HarnessPage
      {...props}
      harness="claude"
      summary="Sync Claude rules, native subagents, and the canonical global skill catalog."
      runtime={{ harness: "claude", health: runtimeHealth }}
    />
  );
}
