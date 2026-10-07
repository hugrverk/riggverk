import { CopyableBlock } from "../../components/CopyableBlock";
import { Pane } from "../../ui/Pane";

interface BrainPaneProps {
  workspaceValid: boolean;
  brainSetupText: string;
  brainSetupSource: string;
}

/** Brain Setup has nothing to edit: one copy block for the assistant's custom instructions. */
export function BrainPane({ workspaceValid, brainSetupText, brainSetupSource }: BrainPaneProps) {
  return (
    <Pane
      id="editor"
      label="Brain Setup"
      title="brain setup"
      meta={workspaceValid && brainSetupSource ? `· source: ${brainSetupSource}` : undefined}
      scrollable
    >
      {!workspaceValid ? (
        <p className="c-dim" role="status">
          <span aria-hidden="true">$ </span>
          No valid workspace selected
        </p>
      ) : (
        <div className="brain-setup-lib-body">
          <p className="brain-setup-lib-summary">
            Copy this block into your assistant&apos;s custom instructions. It teaches skill routing,
            security rules, and verification discipline. Agent Workspace does not control external chat UIs.
          </p>
          <CopyableBlock text={brainSetupText} className="copyable-block-terminal">
            <pre className="brain-setup-pre">{brainSetupText}</pre>
          </CopyableBlock>
        </div>
      )}
    </Pane>
  );
}
