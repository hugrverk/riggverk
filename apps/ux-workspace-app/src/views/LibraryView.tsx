import { Markdown } from "../components/Markdown";
import type { ActionResult } from "../components/TerminalOutput";
import type {
  AgentSourceContent,
  AgentSourceSummary,
  AgentTargetMeta,
  DocSummary,
  DocumentContent,
  SkillSummary,
} from "../types";

export type LibrarySourceType = "docs" | "rules" | "skills" | "agents" | "configs";

const SOURCE_TYPES: { id: LibrarySourceType; label: string; icon: string }[] = [
  { id: "docs", label: "Docs", icon: "\u2630" },
  { id: "rules", label: "Rules", icon: "\u2691" },
  { id: "skills", label: "Skills", icon: "\u2699" },
  { id: "agents", label: "Agents", icon: "\u263A" },
  { id: "configs", label: "Configs", icon: "\u2692" },
];

interface LibraryViewProps {
  sourceType: LibrarySourceType;
  onSetSourceType: (type: LibrarySourceType) => void;

  // Docs
  docs: DocSummary[];
  activeDoc: DocumentContent | null;
  onSelectDoc: (id: string) => void;
  onOpenDoc: (id: string) => void;
  docDraft: string;
  docDirty: boolean;
  docSaving: boolean;
  docSaveResult: ActionResult | null;
  docMode: "preview" | "edit";
  onSetDocMode: (mode: "preview" | "edit") => void;
  onChangeDocDraft: (value: string) => void;
  onSaveDoc: () => void;
  onResetDoc: () => void;
  showCreateDoc: boolean;
  createDocTitle: string;
  createDocSlug: string;
  createDocError: string | null;
  createDocCreating: boolean;
  onSetShowCreateDoc: (show: boolean) => void;
  onSetCreateDocTitle: (value: string) => void;
  onSetCreateDocSlug: (value: string) => void;
  onCreateDoc: () => void;

  // Rules
  agentTemplate: DocumentContent | null;
  onOpenTemplate: () => void;
  agentTemplateDraft: string;
  agentTemplateDirty: boolean;
  agentTemplateSaving: boolean;
  agentTemplateSaveResult: ActionResult | null;
  agentTemplateMode: "preview" | "edit";
  onSetAgentTemplateMode: (mode: "preview" | "edit") => void;
  onChangeAgentTemplateDraft: (value: string) => void;
  onSaveAgentTemplate: () => void;
  onResetAgentTemplate: () => void;
  agentTargets: AgentTargetMeta[];

  // Skills
  skills: SkillSummary[];
  activeSkillId: string | null;
  activeSkillContent: DocumentContent | null;
  skillSearch: string;
  onSetSkillSearch: (value: string) => void;
  onSelectSkillPreview: (id: string) => void;
  onOpenSkill: (id: string) => void;

  // Agents
  agentSources: AgentSourceSummary[];
  activeAgentId: string | null;
  activeAgentContent: AgentSourceContent | null;
  onSelectAgent: (id: string) => void;
  onOpenAgent: (id: string) => void;
  agentDraft: string;
  agentDirty: boolean;
  agentSaving: boolean;
  agentSaveResult: ActionResult | null;
  agentMode: "preview" | "edit";
  onSetAgentMode: (mode: "preview" | "edit") => void;
  onChangeAgentDraft: (value: string) => void;
  onSaveAgent: () => void;
  onResetAgent: () => void;

  // Configs
  configTemplateContent: DocumentContent | null;
  activeConfigTargetId: string;
  configTargets: AgentTargetMeta[];
  onSelectConfigTarget: (targetId: string) => void;
  onOpenConfig: () => void;
  configDraft: string;
  configDirty: boolean;
  configSaving: boolean;
  configSaveResult: ActionResult | null;
  configMode: "preview" | "edit";
  onSetConfigMode: (mode: "preview" | "edit") => void;
  onChangeConfigDraft: (value: string) => void;
  onSaveConfig: () => void;
  onResetConfig: () => void;

  // Common
  workspaceValid: boolean;
}

function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

// ── sidebar item list components ──

function DocItemList({
  docs,
  activeId,
  onSelect,
  workspaceValid,
  onNewDoc,
}: {
  docs: DocSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  workspaceValid: boolean;
  onNewDoc: () => void;
}) {
  if (docs.length === 0) {
    return (
      <div className="lib-sidebar-body">
        <div className="lib-sidebar-empty">
          {workspaceValid
            ? "No docs found"
            : "No valid workspace"}
        </div>
        {workspaceValid && (
          <button className="btn btn-sm btn-primary lib-new-btn" onClick={onNewDoc}>
            + new
          </button>
        )}
      </div>
    );
  }

  const groups: Map<string, DocSummary[]> = new Map();
  for (const d of docs) {
    const existing = groups.get(d.section) ?? [];
    existing.push(d);
    groups.set(d.section, existing);
  }

  return (
    <div className="lib-sidebar-body">
      {Array.from(groups.entries()).map(([section, items]) => (
        <div key={section} className="lib-sidebar-group">
          <div className="lib-sidebar-group-label">{section}</div>
          {items.map((d) => (
            <button
              key={d.id}
              className={`lib-sidebar-item ${activeId === d.id ? "lib-sidebar-item-active" : ""}`}
              onClick={() => onSelect(d.id)}
              aria-current={activeId === d.id ? "true" : undefined}
            >
              <span className="lib-sidebar-item-title">{d.title}</span>
              {d.source === "custom" && (
                <span className="lib-sidebar-item-tag">context</span>
              )}
            </button>
          ))}
        </div>
      ))}
      {workspaceValid && (
        <button className="btn btn-sm btn-primary lib-new-btn" onClick={onNewDoc}>
          + new doc
        </button>
      )}
    </div>
  );
}

function RulesItemList({
  agentTemplate,
  ruleTargets,
}: {
  agentTemplate: DocumentContent | null;
  ruleTargets: AgentTargetMeta[];
}) {
  return (
    <div className="lib-sidebar-body">
      <div className="lib-sidebar-group">
        <div className="lib-sidebar-group-label">Source</div>
        <button
          className={`lib-sidebar-item ${agentTemplate ? "lib-sidebar-item-active" : ""}`}
          onClick={() => {}}
          aria-current={agentTemplate ? "true" : undefined}
        >
          <span className="lib-sidebar-item-title">Global Rules</span>
          <span className="lib-sidebar-item-tag">template</span>
        </button>
      </div>
      {ruleTargets.length > 0 && (
        <div className="lib-sidebar-group">
          <div className="lib-sidebar-group-label">Targets</div>
          {ruleTargets.map((t) => (
            <div key={t.id} className="lib-sidebar-item lib-sidebar-item-meta">
              <span className="lib-sidebar-item-title">{t.label}</span>
              <span className="lib-sidebar-item-path">{t.target_rel}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillItemList({
  skills,
  activeId,
  onSelect,
  search,
  onSearch,
}: {
  skills: SkillSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearch: (v: string) => void;
}) {
  const q = search.toLowerCase().trim();
  const filtered = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q)
      )
    : skills;

  return (
    <div className="lib-sidebar-body">
      <div className="lib-sidebar-search">
        <input
          className="lib-search-input"
          type="text"
          placeholder="search skills..."
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          aria-label="Search skills"
        />
        {search && (
          <button className="btn btn-sm lib-search-clear" onClick={() => onSearch("")}>
            x
          </button>
        )}
      </div>
      {filtered.length === 0 ? (
        <div className="lib-sidebar-empty">No skills match</div>
      ) : (
        <div className="lib-sidebar-list">
          {filtered.map((s) => (
            <button
              key={s.id}
              className={`lib-sidebar-item ${activeId === s.id ? "lib-sidebar-item-active" : ""}`}
              onClick={() => onSelect(s.id)}
              aria-current={activeId === s.id ? "true" : undefined}
            >
              <span className="lib-sidebar-item-title">{s.name}</span>
              <span className="lib-sidebar-item-desc">{s.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentItemList({
  agents,
  activeId,
  onSelect,
}: {
  agents: AgentSourceSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  if (agents.length === 0) {
    return (
      <div className="lib-sidebar-body">
        <div className="lib-sidebar-empty">No agents found</div>
      </div>
    );
  }

  return (
    <div className="lib-sidebar-body">
      {agents.map((a) => (
        <button
          key={a.id}
          className={`lib-sidebar-item ${activeId === a.id ? "lib-sidebar-item-active" : ""} ${!a.exists ? "lib-sidebar-item-missing" : ""}`}
          onClick={() => onSelect(a.id)}
          aria-current={activeId === a.id ? "true" : undefined}
        >
          <span className="lib-sidebar-item-title">{a.title}</span>
          <span className="lib-sidebar-item-desc">{a.id}</span>
          {!a.exists && (
            <span className="lib-sidebar-item-tag lib-sidebar-item-tag-warn">not in ws</span>
          )}
        </button>
      ))}
    </div>
  );
}

function ConfigItemList({
  configTargets,
  activeTargetId,
  onSelect,
  configContent,
}: {
  configTargets: AgentTargetMeta[];
  activeTargetId: string;
  onSelect: (id: string) => void;
  configContent: DocumentContent | null;
}) {
  return (
    <div className="lib-sidebar-body">
      <div className="lib-sidebar-group">
        <div className="lib-sidebar-group-label">Targets</div>
        {configTargets.map((t) => (
          <button
            key={t.id}
            className={`lib-sidebar-item ${activeTargetId === t.id ? "lib-sidebar-item-active" : ""}`}
            onClick={() => onSelect(t.id)}
            aria-current={activeTargetId === t.id ? "true" : undefined}
          >
            <span className="lib-sidebar-item-title">{t.label}</span>
            <span className="lib-sidebar-item-path">{t.source_rel}</span>
          </button>
        ))}
      </div>
      {configContent && activeTargetId === "opencode_config" && (
        <div className="lib-sidebar-group">
          <div className="lib-sidebar-group-label">Bundle</div>
          <div className="lib-sidebar-item lib-sidebar-item-meta">
            <span className="lib-sidebar-item-title">Config + Agents</span>
            <span className="lib-sidebar-item-desc">6 agents bundled</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── type helpers ──

function sourceTypeLabel(type: LibrarySourceType): string {
  switch (type) {
    case "docs": return "Docs";
    case "rules": return "Rules";
    case "skills": return "Skills";
    case "agents": return "Agents";
    case "configs": return "Configs";
  }
}

// ── main view ──

export function LibraryView(props: LibraryViewProps) {
  const {
    sourceType,
    onSetSourceType,
    docs,
    activeDoc,
    onSelectDoc,
    onOpenDoc,
    docDraft,
    docDirty,
    docSaving,
    docSaveResult,
    docMode,
    onSetDocMode,
    onChangeDocDraft,
    onSaveDoc,
    onResetDoc,
    showCreateDoc,
    createDocTitle,
    createDocSlug,
    createDocError,
    createDocCreating,
    onSetShowCreateDoc,
    onSetCreateDocTitle,
    onSetCreateDocSlug,
    onCreateDoc,
    agentTemplate,
    onOpenTemplate,
    agentTemplateDraft,
    agentTemplateDirty,
    agentTemplateSaving,
    agentTemplateSaveResult,
    agentTemplateMode,
    onSetAgentTemplateMode,
    onChangeAgentTemplateDraft,
    onSaveAgentTemplate,
    onResetAgentTemplate,
    agentTargets,
    skills,
    activeSkillId,
    activeSkillContent,
    skillSearch,
    onSetSkillSearch,
    onSelectSkillPreview,
    onOpenSkill,
    agentSources,
    activeAgentId,
    activeAgentContent,
    onSelectAgent,
    onOpenAgent,
    agentDraft,
    agentDirty,
    agentSaving,
    agentSaveResult,
    agentMode,
    onSetAgentMode,
    onChangeAgentDraft,
    onSaveAgent,
    onResetAgent,
    configTemplateContent,
    activeConfigTargetId,
    configTargets,
    onSelectConfigTarget,
    onOpenConfig,
    configDraft,
    configDirty,
    configSaving,
    configSaveResult,
    configMode,
    onSetConfigMode,
    onChangeConfigDraft,
    onSaveConfig,
    onResetConfig,
    workspaceValid,
  } = props;

  const ruleTargets = agentTargets.filter((t) => t.kind === "rules");
  const selectedConfigTarget = configTargets.find((t) => t.id === activeConfigTargetId);

  // ── derive active content for main pane ──

  let mainContent: React.ReactNode = null;

  switch (sourceType) {
    case "docs":
      if (activeDoc) {
        mainContent = (
          <>
            <div className="lib-editor-meta-strip">
              <div className="lib-editor-meta-left">
                <span className="lib-editor-meta-title">{activeDoc.title}</span>
                <span className="lib-editor-meta-path">
                  {activeDoc.section} &middot; {activeDoc.path}
                  {activeDoc.source === "custom" && (
                    <span className="docs-source-tag">context</span>
                  )}
                </span>
              </div>
              <div className="lib-editor-meta-right">
                {docDirty && <span className="editor-dirty" aria-label="Unsaved changes">modified</span>}
                <button className="btn btn-sm" onClick={() => onOpenDoc(activeDoc.id)}>open</button>
              </div>
            </div>
            <div className="editor-mode-tabs" role="tablist" aria-label="Doc view mode">
              <button className={`btn btn-sm ${docMode === "preview" ? "btn-active" : ""}`} onClick={() => onSetDocMode("preview")} role="tab" aria-selected={docMode === "preview"}>preview</button>
              <button className={`btn btn-sm ${docMode === "edit" ? "btn-active" : ""}`} onClick={() => onSetDocMode("edit")} role="tab" aria-selected={docMode === "edit"}>edit</button>
            </div>
            <div className="lib-editor-body">
              {docMode === "preview" ? (
                <div className="lib-preview-body"><Markdown content={activeDoc.content} /></div>
              ) : (
                <textarea
                  className="editor-textarea"
                  value={docDraft}
                  onChange={(e) => onChangeDocDraft(e.target.value)}
                  spellCheck={false}
                  aria-label="Edit document"
                />
              )}
            </div>
            {docMode === "edit" && (
              <div className="editor-save-row">
                <button className="btn btn-primary btn-sm" onClick={onSaveDoc} disabled={docSaving || !docDirty}>
                  {docSaving ? "saving..." : "save"}
                </button>
                <button className="btn btn-sm" onClick={onResetDoc} disabled={docSaving || !docDirty}>reset</button>
                {docSaveResult && (
                  <span className={`editor-save-status ${docSaveResult.success ? "editor-save-ok" : "editor-save-fail"}`}>
                    {docSaveResult.success ? docSaveResult.stdout : docSaveResult.stderr || "save failed"}
                  </span>
                )}
              </div>
            )}
            {showCreateDoc && (
              <div className="docs-create-form">
                <label className="docs-create-label">
                  <span>Title</span>
                  <input className="docs-create-input" type="text" placeholder="My Context Notes" value={createDocTitle} onChange={(e) => onSetCreateDocTitle(e.target.value)} aria-label="New doc title" />
                </label>
                <label className="docs-create-label">
                  <span>Slug</span>
                  <input className="docs-create-input" type="text" placeholder="my-context-notes" value={createDocSlug} onChange={(e) => onSetCreateDocSlug(e.target.value)} aria-label="New doc slug" />
                </label>
                <div className="docs-create-actions">
                  <button className="btn btn-primary btn-sm" onClick={onCreateDoc} disabled={createDocCreating || !createDocTitle.trim() || !createDocSlug.trim()}>
                    {createDocCreating ? "creating..." : "create"}
                  </button>
                  <button className="btn btn-sm" onClick={() => { onSetShowCreateDoc(false); }}>cancel</button>
                  <span className="docs-create-hint">docs/context/</span>
                </div>
                {createDocError && <div className="docs-create-error">{createDocError}</div>}
              </div>
            )}
          </>
        );
      }
      break;

    case "rules":
      if (agentTemplate) {
        mainContent = (
          <>
            <div className="lib-editor-meta-strip">
              <div className="lib-editor-meta-left">
                <span className="lib-editor-meta-title">Global Rules</span>
                <span className="lib-editor-meta-path">{agentTemplate.path}</span>
              </div>
              <div className="lib-editor-meta-right">
                {agentTemplateDirty && <span className="editor-dirty" aria-label="Unsaved changes">modified</span>}
                <button className="btn btn-sm" onClick={onOpenTemplate}>open</button>
              </div>
            </div>
            <div className="editor-mode-tabs" role="tablist" aria-label="Rules view mode">
              <button className={`btn btn-sm ${agentTemplateMode === "preview" ? "btn-active" : ""}`} onClick={() => onSetAgentTemplateMode("preview")} role="tab" aria-selected={agentTemplateMode === "preview"}>preview</button>
              <button className={`btn btn-sm ${agentTemplateMode === "edit" ? "btn-active" : ""}`} onClick={() => onSetAgentTemplateMode("edit")} role="tab" aria-selected={agentTemplateMode === "edit"}>edit</button>
            </div>
            <div className="lib-editor-body">
              {agentTemplateMode === "preview" ? (
                <div className="lib-preview-body"><Markdown content={agentTemplate.content} /></div>
              ) : (
                <textarea
                  className="editor-textarea"
                  value={agentTemplateDraft}
                  onChange={(e) => onChangeAgentTemplateDraft(e.target.value)}
                  spellCheck={false}
                  aria-label="Edit agent rules template"
                />
              )}
            </div>
            {agentTemplateMode === "edit" && (
              <div className="editor-save-row">
                <button className="btn btn-primary btn-sm" onClick={onSaveAgentTemplate} disabled={agentTemplateSaving || !agentTemplateDirty}>
                  {agentTemplateSaving ? "saving..." : "save"}
                </button>
                <button className="btn btn-sm" onClick={onResetAgentTemplate} disabled={agentTemplateSaving || !agentTemplateDirty}>reset</button>
                {agentTemplateSaveResult && (
                  <span className={`editor-save-status ${agentTemplateSaveResult.success ? "editor-save-ok" : "editor-save-fail"}`}>
                    {agentTemplateSaveResult.success ? agentTemplateSaveResult.stdout : agentTemplateSaveResult.stderr || "save failed"}
                  </span>
                )}
                <span className="editor-save-note">template only</span>
              </div>
            )}
          </>
        );
      }
      break;

    case "skills":
      if (activeSkillContent) {
        mainContent = (
          <>
            <div className="lib-editor-meta-strip">
              <div className="lib-editor-meta-left">
                <span className="lib-editor-meta-title">{activeSkillContent.title}</span>
                <span className="lib-editor-meta-path">{activeSkillContent.section} &middot; {activeSkillContent.path}</span>
              </div>
              <div className="lib-editor-meta-right">
                <button className="btn btn-sm" onClick={() => onOpenSkill(activeSkillContent.id)}>open</button>
              </div>
            </div>
            <div className="lib-editor-body">
              <div className="lib-preview-body"><Markdown content={activeSkillContent.content} /></div>
            </div>
          </>
        );
      }
      break;

    case "agents":
      if (activeAgentContent) {
        mainContent = (
          <>
            <div className="lib-editor-meta-strip">
              <div className="lib-editor-meta-left">
                <span className="lib-editor-meta-title">{activeAgentContent.title}</span>
                <span className="lib-editor-meta-path">{activeAgentContent.path}</span>
                {!activeAgentContent.exists && (
                  <span className="lib-sidebar-item-tag lib-sidebar-item-tag-warn">not in workspace</span>
                )}
              </div>
              <div className="lib-editor-meta-right">
                {agentDirty && <span className="editor-dirty" aria-label="Unsaved changes">modified</span>}
                <button className="btn btn-sm" onClick={() => onOpenAgent(activeAgentContent.id)}>open</button>
              </div>
            </div>
            <div className="editor-mode-tabs" role="tablist" aria-label="Agent view mode">
              <button className={`btn btn-sm ${agentMode === "preview" ? "btn-active" : ""}`} onClick={() => onSetAgentMode("preview")} role="tab" aria-selected={agentMode === "preview"}>preview</button>
              <button className={`btn btn-sm ${agentMode === "edit" ? "btn-active" : ""}`} onClick={() => onSetAgentMode("edit")} role="tab" aria-selected={agentMode === "edit"}>edit</button>
            </div>
            <div className="lib-editor-body">
              {agentMode === "preview" ? (
                <div className="lib-preview-body"><Markdown content={activeAgentContent.content} /></div>
              ) : (
                <textarea
                  className="editor-textarea"
                  value={agentDraft}
                  onChange={(e) => onChangeAgentDraft(e.target.value)}
                  spellCheck={false}
                  aria-label="Edit agent source"
                />
              )}
            </div>
            {agentMode === "edit" && (
              <div className="editor-save-row">
                <button className="btn btn-primary btn-sm" onClick={onSaveAgent} disabled={agentSaving || !agentDirty}>
                  {agentSaving ? "saving..." : "save"}
                </button>
                <button className="btn btn-sm" onClick={onResetAgent} disabled={agentSaving || !agentDirty}>reset</button>
                {agentSaveResult && (
                  <span className={`editor-save-status ${agentSaveResult.success ? "editor-save-ok" : "editor-save-fail"}`}>
                    {agentSaveResult.success ? agentSaveResult.stdout : agentSaveResult.stderr || "save failed"}
                  </span>
                )}
                <span className="editor-save-note">workspace source</span>
              </div>
            )}
          </>
        );
      }
      break;

    case "configs":
      if (configTemplateContent) {
        const sourcePath = selectedConfigTarget?.source_rel ?? "";
        const targetPath = selectedConfigTarget?.target_rel ?? "";
        mainContent = (
          <>
            <div className="lib-editor-meta-strip">
              <div className="lib-editor-meta-left">
                <span className="lib-editor-meta-title">{selectedConfigTarget?.label ?? "Config"}</span>
                <span className="lib-editor-meta-path">
                  {sourcePath && <span>template: {sourcePath}</span>}
                  {sourcePath && targetPath && <span> &middot; </span>}
                  {targetPath && <span>target: {targetPath}</span>}
                </span>
              </div>
              <div className="lib-editor-meta-right">
                {configDirty && <span className="editor-dirty" aria-label="Unsaved changes">modified</span>}
                <button className="btn btn-sm" onClick={onOpenConfig}>open</button>
              </div>
            </div>
            {activeConfigTargetId === "opencode_config" && (
              <div className="configs-bundle-section" role="region" aria-label="OpenCode config + agents bundle">
                <span className="configs-bundle-header">bundle contents</span>
                <span className="configs-bundle-item">
                  <span className="configs-bundle-key">config</span>
                  <span className="configs-bundle-val">templates/opencode.json &rarr; ~/.config/opencode/opencode.json</span>
                </span>
                <span className="configs-bundle-item">
                  <span className="configs-bundle-key">agents</span>
                  <span className="configs-bundle-val">agents/*.md &rarr; ~/.config/opencode/agents/*.md</span>
                </span>
                <span className="configs-bundle-item">
                  <span className="configs-bundle-key">bundled</span>
                  <span className="configs-bundle-val">6 agents</span>
                </span>
                <span className="configs-bundle-note">sync writes both config + agent files</span>
              </div>
            )}
            <div className="editor-mode-tabs" role="tablist" aria-label="Config view mode">
              <button className={`btn btn-sm ${configMode === "preview" ? "btn-active" : ""}`} onClick={() => onSetConfigMode("preview")} role="tab" aria-selected={configMode === "preview"}>preview</button>
              <button className={`btn btn-sm ${configMode === "edit" ? "btn-active" : ""}`} onClick={() => onSetConfigMode("edit")} role="tab" aria-selected={configMode === "edit"}>edit</button>
            </div>
            <div className="lib-editor-body">
              {configMode === "preview" ? (
                <pre className="configs-code">{formatJson(configTemplateContent.content)}</pre>
              ) : (
                <textarea
                  className="editor-textarea"
                  value={configDraft}
                  onChange={(e) => onChangeConfigDraft(e.target.value)}
                  spellCheck={false}
                  aria-label="Edit config template"
                />
              )}
            </div>
            {configMode === "edit" && (
              <div className="editor-save-row">
                <button className="btn btn-primary btn-sm" onClick={onSaveConfig} disabled={configSaving || !configDirty}>
                  {configSaving ? "saving..." : "save"}
                </button>
                <button className="btn btn-sm" onClick={onResetConfig} disabled={configSaving || !configDirty}>reset</button>
                {configSaveResult && (
                  <span className={`editor-save-status ${configSaveResult.success ? "editor-save-ok" : "editor-save-fail"}`}>
                    {configSaveResult.success ? configSaveResult.stdout : configSaveResult.stderr || "save failed"}
                  </span>
                )}
                <span className="editor-save-note">template only</span>
              </div>
            )}
          </>
        );
      }
      break;
  }

  const sourceTypeTitle = sourceTypeLabel(sourceType);

  // Sidebar content per source type
  const sidebarContent = () => {
    switch (sourceType) {
      case "docs":
        return (
          <DocItemList
            docs={docs}
            activeId={activeDoc?.id ?? null}
            onSelect={onSelectDoc}
            workspaceValid={workspaceValid}
            onNewDoc={() => onSetShowCreateDoc(!showCreateDoc)}
          />
        );
      case "rules":
        return <RulesItemList agentTemplate={agentTemplate} ruleTargets={ruleTargets} />;
      case "skills":
        return (
          <SkillItemList
            skills={skills}
            activeId={activeSkillId}
            onSelect={onSelectSkillPreview}
            search={skillSearch}
            onSearch={onSetSkillSearch}
          />
        );
      case "agents":
        return <AgentItemList agents={agentSources} activeId={activeAgentId} onSelect={onSelectAgent} />;
      case "configs":
        return (
          <ConfigItemList
            configTargets={configTargets}
            activeTargetId={activeConfigTargetId}
            onSelect={onSelectConfigTarget}
            configContent={configTemplateContent}
          />
        );
    }
  };

  // Count helpers for source rail badges
  const docsCount = docs.length;
  const skillsCount = skills.length;
  const agentsCount = agentSources.length;
  const configCount = configTargets.length;

  function sourceCount(type: LibrarySourceType): string | null {
    switch (type) {
      case "docs": return docsCount > 0 ? String(docsCount) : null;
      case "skills": return skillsCount > 0 ? String(skillsCount) : null;
      case "agents": return agentsCount > 0 ? String(agentsCount) : null;
      case "configs": return configCount > 0 ? String(configCount) : null;
      default: return null;
    }
  }

  return (
    <section className="lib-frame">
      <div className="lib-topline">
        <span className="terminal-title">LIBRARY</span>
        <span className="terminal-host">source files &middot; {sourceTypeTitle.toLowerCase()}</span>
      </div>

      <div className="lib-layout">
        {/* Vertical source rail */}
        <nav className="lib-source-rail" role="tablist" aria-label="Source type">
          {SOURCE_TYPES.map((st) => {
            const count = sourceCount(st.id);
            return (
              <button
                key={st.id}
                className={`lib-source-rail-btn ${sourceType === st.id ? "lib-source-rail-btn-active" : ""}`}
                onClick={() => onSetSourceType(st.id)}
                role="tab"
                aria-selected={sourceType === st.id}
                title={`${st.label}${count ? ` (${count})` : ""}`}
              >
                <span className="lib-source-rail-icon">{st.icon}</span>
                <span className="lib-source-rail-label">{st.label}</span>
                {count && <span className="lib-source-rail-count">{count}</span>}
              </button>
            );
          })}
        </nav>

        {/* Item list sidebar */}
        <div className="lib-sidebar">
          {sidebarContent()}
        </div>

        {/* Main content */}
        <div className="lib-main">
          {mainContent ? (
            mainContent
          ) : (
            <div className="lib-main-empty">
              <span className="log-prompt">$</span>{" "}
              {workspaceValid
                ? `Select a ${sourceTypeTitle.toLowerCase()} source to preview`
                : "No valid workspace selected"}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
