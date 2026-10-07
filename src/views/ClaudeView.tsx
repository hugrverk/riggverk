import type { ClaudeRuntimeHealth } from "../types";
import { HarnessPage } from "./HarnessPage";
import type { HarnessViewProps } from "./pageTypes";

export function ClaudeView({ runtimeHealth, ...props }: HarnessViewProps & { runtimeHealth: ClaudeRuntimeHealth | null }) {
  return (
    <HarnessPage
      {...props}
      harness="claude"
      runtime={{ harness: "claude", health: runtimeHealth }}
    />
  );
}
