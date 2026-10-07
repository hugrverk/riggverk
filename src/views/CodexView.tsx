import type { CodexRuntimeHealth } from "../types";
import { HarnessPage } from "./HarnessPage";
import type { HarnessViewProps } from "./pageTypes";

export function CodexView({ runtimeHealth, ...props }: HarnessViewProps & { runtimeHealth: CodexRuntimeHealth | null }) {
  return (
    <HarnessPage
      {...props}
      harness="codex"
      runtime={{ harness: "codex", health: runtimeHealth }}
    />
  );
}
