import type { CursorProfileHealth } from "../types";
import { HarnessPage } from "./HarnessPage";
import type { HarnessViewProps } from "./pageTypes";

export function CursorView({ runtimeHealth, ...props }: HarnessViewProps & { runtimeHealth: CursorProfileHealth | null }) {
  return (
    <HarnessPage
      {...props}
      harness="cursor"
      runtime={{ harness: "cursor", health: runtimeHealth }}
    />
  );
}
