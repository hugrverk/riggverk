import { useState, useCallback, useMemo } from "react";
import { buildBrainSetupBlock } from "./routing/routingHelpers";

interface RoutingViewProps {
  workspaceValid: boolean;
}

export function RoutingView({ workspaceValid }: RoutingViewProps) {
  const [brainSetupCopied, setBrainSetupCopied] = useState(false);

  const brainSetupBlock = useMemo(() => buildBrainSetupBlock(), []);

  const onCopyBrainSetup = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(brainSetupBlock);
      setBrainSetupCopied(true);
      setTimeout(() => setBrainSetupCopied(false), 2000);
    } catch {
      const el = document.getElementById("brain-setup-block");
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }, [brainSetupBlock]);

  return (
    <section className="lib-frame">
      <div className="lib-topline">
        <span className="terminal-title">Brain Setup</span>
        <span className="terminal-host">
          Teach your AI assistant how to route work through installed skills.
        </span>
      </div>

      <div className="lib-layout">
        <div className="lib-main">
          {!workspaceValid ? (
            <div className="brain-empty-state">No valid workspace selected</div>
          ) : (
            <div className="brain-setup-page">
              <div className="brain-setup-grid">
                {/* ── Left column: explanation + actions + steps ── */}
                <div className="brain-setup-left" role="region" aria-label="Brain Setup instructions">
                  <h1 className="brain-setup-heading">Brain Setup</h1>
                  <p className="brain-setup-subtitle">
                    Teach your AI assistant how to route work through installed skills.
                  </p>
                  <p className="brain-setup-explain">
                    Agent Workspace does not automatically control ChatGPT, Claude Web, Codex, or other
                    external assistants. Skill routing works when you give your assistant persistent
                    instructions. Paste the block into Custom Instructions, Claude Project Instructions,
                    Codex project instructions, or the first message of a long-running assistant
                    workspace. Your assistant will then route tasks through the installed skills,
                    recommend models, check DB/migration status, and enforce verification discipline.
                  </p>

                  <div className="brain-setup-copy-row">
                    <button className="btn btn-primary" onClick={onCopyBrainSetup}>
                      {brainSetupCopied ? "copied" : "copy brain setup"}
                    </button>
                    {brainSetupCopied && (
                      <span className="editor-save-status editor-save-ok">copied to clipboard</span>
                    )}
                  </div>

                  <div className="brain-setup-step-list">
                    <div className="brain-setup-step">
                      <span className="brain-setup-step-num">1. copy</span>
                      <span className="brain-setup-step-text">Copy the setup block.</span>
                    </div>
                    <div className="brain-setup-step">
                      <span className="brain-setup-step-num">2. paste</span>
                      <span className="brain-setup-step-text">Paste into your assistant&rsquo;s Custom Instructions or project instructions.</span>
                    </div>
                    <div className="brain-setup-step">
                      <span className="brain-setup-step-num">3. prompt</span>
                      <span className="brain-setup-step-text">Ask for implementation plans or coding tasks. Your assistant will route through skills automatically.</span>
                    </div>
                  </div>
                </div>

                {/* ── Right column: prompt preview ── */}
                <div className="brain-setup-right" role="region" aria-label="Brain setup prompt preview">
                  <div className="brain-preview-card">
                    <div className="brain-preview-header">
                      <span className="brain-preview-title">Brain setup prompt</span>
                      <span className="brain-preview-hint">This is the exact block copied to clipboard.</span>
                    </div>
                    <pre id="brain-setup-block" className="brain-setup-pre">
                      {brainSetupBlock}
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
