import { useState } from "react";
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
  // Unsaved model edits live in the rows; the page holds Update and Preview until they are saved or dropped.
  const [modelUnsaved, setModelUnsaved] = useState(false);
  return (
    <HarnessPage
      {...props}
      installBlockedBy={modelUnsaved ? "Save or discard the model change first" : undefined}
      harness="opencode"
      runtime={{ harness: "opencode", health: runtimeHealth }}
      runtimeExtra={<OpenCodeModelRows dataFolderOk={props.dataFolderOk} health={runtimeHealth} onModelUpdated={onModelUpdated} onUnsavedChange={setModelUnsaved} />}
    />
  );
}
