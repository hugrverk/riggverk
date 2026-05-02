import { Markdown } from "../components/Markdown";
import type { DocumentContent } from "../types";

interface AgentRulesViewProps {
  agentTemplate: DocumentContent | null;
  onBack: () => void;
  onOpenTemplate: () => void;
}

export function AgentRulesView({ agentTemplate, onBack, onOpenTemplate }: AgentRulesViewProps) {
  return (
    <section className="terminal terminal-view">
      <div className="terminal-topline">
        <span className="terminal-title">GLOBAL AGENT RULES</span>
        <div className="configs-frame-actions">
          <button className="btn btn-sm" onClick={onBack}>← back</button>
        </div>
      </div>
      {agentTemplate ? (
        <div className="doc-viewer">
          <div className="doc-viewer-header">
            <span className="cell-value">{agentTemplate.path}</span>
            <button className="btn btn-sm" onClick={onOpenTemplate}>open</button>
          </div>
          <div className="doc-viewer-body"><Markdown content={agentTemplate.content} /></div>
        </div>
      ) : (
        <div className="log-empty" style={{padding:"2rem"}}><span className="log-prompt">$</span> no template loaded</div>
      )}
    </section>
  );
}
