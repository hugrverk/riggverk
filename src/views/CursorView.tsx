import type { CursorProfileHealth } from "../types";
import { HarnessPage } from "./HarnessPage";
import type { HarnessViewProps } from "./pageTypes";

export function CursorView({ runtimeHealth, ...props }: HarnessViewProps & { runtimeHealth: CursorProfileHealth | null }) {
  return (
    <HarnessPage
      {...props}
      harness="cursor"
      summary="Sync Cursor agents, canonical bundled skills, and Playwright MCP. Auto Review, sandbox behavior, and general permissions remain IDE-managed in Cursor Settings."
      runtime={{ harness: "cursor", health: runtimeHealth }}
    />
  );
}
