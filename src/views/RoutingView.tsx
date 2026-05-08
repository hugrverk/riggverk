import { useState, useCallback, useMemo } from "react";
import { buildBrainSetupBlock } from "../lib/brainSetup";

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
                {/* ── Left column ── */}
                <div className="brain-setup-left" role="region" aria-label="Brain Setup instructions">
                  <span className="brain-setup-eyebrow">Brain Setup</span>
                  <h1 className="brain-setup-heading">Copy your assistant setup</h1>
                  <p className="brain-setup-subtitle">
                    Teach ChatGPT, Claude, Codex, or another assistant to route work through
                    installed skills.
                  </p>
                  <p className="brain-setup-explain">
                    Agent Workspace cannot control external chat UIs directly. This setup block
                    teaches your assistant how to apply installed skills, recommend tools and models,
                    check DB risk, and require verification before claiming anything passed.
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
                      <span className="brain-setup-step-text">Paste into your assistant&rsquo;s Custom Instructions.</span>
                    </div>
                    <div className="brain-setup-step">
                      <span className="brain-setup-step-num">3. prompt</span>
                      <span className="brain-setup-step-text">Ask for implementation plans. Your assistant routes through skills.</span>
                    </div>
                  </div>
                </div>

                {/* ── Right column ── */}
                <div className="brain-setup-right" role="region" aria-label="Prompt preview">
                  <div className="brain-preview-card">
                    <div className="brain-preview-header">
                      <span className="brain-preview-title">Prompt preview</span>
                      <span className="brain-preview-hint">This exact text is copied to clipboard.</span>
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
