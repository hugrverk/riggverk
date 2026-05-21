import { CopyableBlock } from "../../components/CopyableBlock";

interface BrainSetupContentProps {
  workspaceValid: boolean;
  brainSetupText: string;
  brainSetupSource: string;
}

export function BrainSetupContent({
  workspaceValid,
  brainSetupText,
  brainSetupSource,
}: BrainSetupContentProps) {
  if (!workspaceValid) {
    return (
      <div className="lib-main-empty">
        <span className="log-prompt">$</span> No valid workspace selected
      </div>
    );
  }

  return (
    <>
      <div className="lib-editor-meta-strip">
        <div className="lib-editor-meta-left">
          <span className="lib-editor-meta-title">Brain Setup</span>
          <span className="lib-editor-meta-path">source: {brainSetupSource}</span>
        </div>
      </div>
      <div className="brain-setup-lib-body">
        <p className="brain-setup-lib-summary">
          Copy this block into your assistant&apos;s custom instructions. It teaches skill routing,
          security rules, and verification discipline. Agent Workspace does not control external chat UIs.
        </p>
        <CopyableBlock text={brainSetupText} className="copyable-block-terminal">
          <pre className="brain-setup-pre">{brainSetupText}</pre>
        </CopyableBlock>
      </div>
    </>
  );
}
