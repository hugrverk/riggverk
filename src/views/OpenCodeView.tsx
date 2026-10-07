import type { OpenCodeRuntimeHealth } from "../types";
import { HarnessPage } from "./HarnessPage";
import { OpenCodeModelRows } from "./OpenCodeModelRows";
import type { HarnessViewProps } from "./pageTypes";

interface OpenCodeViewProps extends HarnessViewProps {
  runtimeHealth: OpenCodeRuntimeHealth | null;
  /** The saved model override changed: reload runtime health and the installation overview. */
  onModelUpdated: () => void;
}

export function OpenCodeView({ runtimeHealth, onModelUpdated, ...props }: OpenCodeViewProps) {
  return (
    <HarnessPage
      {...props}
      harness="opencode"
      runtime={{ harness: "opencode", health: runtimeHealth }}
      runtimeExtra={<OpenCodeModelRows workspaceValid={props.workspaceValid} onModelUpdated={onModelUpdated} />}
    />
  );
}
