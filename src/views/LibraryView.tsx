import { useMemo, useState } from "react";
import { ToolSectionTabs } from "../components/ToolSectionTabs";
import type { ActionResult } from "../components/TerminalOutput";
import type {
  AgentMetadataResponse,
  AgentSourceContent,
  AgentTargetMeta,
  ConfigEditorSourceMeta,
  DocsHealth,
  DocSummary,
  DocumentContent,
  SkillSummary,
} from "../types";
import { DocContent } from "./library/DocContent";
import { RulesContent } from "./library/RulesContent";
import { SkillsContent } from "./library/SkillsContent";
import { AgentContent } from "./library/AgentContent";
import { ConfigContent } from "./library/ConfigContent";
import { BrainSetupContent } from "./library/BrainSetupContent";

export type LibrarySourceType = "docs" | "rules" | "skills" | "agents" | "configs" | "brain";

const SOURCE_TYPES: { id: LibrarySourceType; label: string }[] = [
  { id: "docs", label: "Docs" },
  { id: "rules", label: "Rules" },
  { id: "skills", label: "Skills" },
  { id: "agents", label: "Runtime agents" },
  { id: "configs", label: "Configs" },
  { id: "brain", label: "Brain Setup" },
];

interface LibraryViewProps {
  sourceType: LibrarySourceType;
  onSetSourceType: (type: LibrarySourceType) => void;

  // Docs
  docs: DocSummary[];
  docsHealth: DocsHealth | null;
  onGoToWorkspaceRepair: () => void;
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
  agentSources: AgentMetadataResponse[];
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
  configEditorSources: ConfigEditorSourceMeta[];
  activeConfigSourceType: string;
  onSelectConfigSource: (sourceType: string) => void;
  configEditorSourceSaveMessage: string;
  configEditorSourceContent: DocumentContent | null;

  // Brain Setup
  brainSetupText: string;
  brainSetupSource: string;

  // Common
  workspaceValid: boolean;
}

// ── sidebar item list components ──

function filterDocsForSearch(docs: DocSummary[], query: string): DocSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return docs;
  return docs.filter(
    (d) =>
      d.title.toLowerCase().includes(q) ||
      d.path.toLowerCase().includes(q) ||
      d.section.toLowerCase().includes(q),
  );
}

function DocItemList({
  docs,
  docsHealth,
  activeId,
  onSelect,
  workspaceValid,
  onNewDoc,
  onGoToWorkspaceRepair,
  searchQuery,
  onSearchQueryChange,
}: {
  docs: DocSummary[];
  docsHealth: DocsHealth | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  workspaceValid: boolean;
  onNewDoc: () => void;
  onGoToWorkspaceRepair: () => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
}) {
  const missingCount = docsHealth?.missing_count ?? 0;
  const showStaleBanner = workspaceValid && missingCount > 0;
  const filteredDocs = useMemo(
    () => filterDocsForSearch(docs, searchQuery),
    [docs, searchQuery],
  );

  const groups = useMemo(() => {
    const next = new Map<string, DocSummary[]>();
    for (const d of filteredDocs) {
      const existing = next.get(d.section) ?? [];
      existing.push(d);
      next.set(d.section, existing);
    }
    return next;
  }, [filteredDocs]);

  const staleHint = docsHealth?.missing_prompt_template_docs
    ? "Prompt Templates and other bundled docs are missing from this workspace."
    : `${missingCount} bundled doc(s) are missing from this workspace.`;

  return (
    <aside className="lib-docs-list-pane" aria-label="Document list">
      <label className="lib-docs-search-wrap font-mono">
        <span className="visually-hidden">Filter documents</span>
        <input
          type="search"
          className="lib-field lib-docs-search"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          placeholder="Filter by path or title"
          aria-label="Filter documents"
        />
      </label>

      {showStaleBanner && (
        <div className="lib-docs-stale-banner" role="status">
          <p className="lib-docs-stale-title">Bundled docs need update</p>
          <p className="lib-docs-stale-hint text-muted small">{staleHint}</p>
          <button
            type="button"
            className="btn btn-sm btn-primary lib-docs-stale-action"
            onClick={onGoToWorkspaceRepair}
          >
            open workspace update
          </button>
        </div>
      )}

      {!workspaceValid ? (
        <p className="text-muted small" role="status">No valid workspace</p>
      ) : !docs.length ? (
        <p className="text-muted small" role="status">No docs found</p>
      ) : !filteredDocs.length ? (
        <p className="text-muted small" role="status">No documents match the current filter.</p>
      ) : (
        <ul
          className="lib-docs-list"
          role="listbox"
          aria-label="Workspace documents"
          aria-activedescendant={activeId ? `lib-doc-option-${activeId}` : undefined}
        >
          {Array.from(groups.entries()).map(([section, items]) => (
            <li key={section} role="none" className="lib-docs-list-section">
              <div className="lib-docs-section-label">{section}</div>
              <ul className="lib-docs-list-section-items" role="group" aria-label={section}>
                {items.map((d) => {
                  const selected = activeId === d.id;
                  const optionId = `lib-doc-option-${d.id}`;
                  return (
                    <li key={d.id} role="none">
                      <button
                        type="button"
                        id={optionId}
                        role="option"
                        aria-selected={selected}
                        className={`lib-docs-list-item${selected ? " active" : ""}`}
                        onClick={() => onSelect(d.id)}
                      >
                        <span className="font-mono lib-docs-list-title">{d.title}</span>
                        {d.source === "custom" ? (
                          <span className="lib-pill lib-docs-context-pill">context</span>
                        ) : null}
                        <span className="font-mono lib-docs-list-path text-muted">{d.path}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {workspaceValid && (
        <button type="button" className="btn btn-sm btn-primary lib-docs-new-btn" onClick={onNewDoc}>
          + new doc
        </button>
      )}
    </aside>
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
        <div className={`lib-sidebar-item lib-sidebar-item-meta ${agentTemplate ? "lib-sidebar-item-active" : ""}`}>
          <span className="lib-sidebar-item-title">Global Rules</span>
          <span className="lib-sidebar-item-tag">template</span>
        </div>
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
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return skills;
    return skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q) ||
          s.targets.some((t) => t.toLowerCase().includes(q)) ||
          s.related.some((r) => r.toLowerCase().includes(q))
      );
  }, [skills, search]);

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
          <button className="btn btn-sm lib-search-clear" onClick={() => onSearch("")} aria-label="Clear skills search">clear</button>
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
              <span className="lib-sidebar-item-meta-row">
                {s.category && (
                  <span className="lib-sidebar-item-tag">{s.category}</span>
                )}
                {s.risk && (
                  <span className={`lib-sidebar-item-tag lib-sidebar-item-tag-${s.risk}`}>
                    {s.risk}
                  </span>
                )}
                {s.targets.length > 0 && (
                  <span className="lib-sidebar-item-tag lib-sidebar-item-tag-dim">{s.targets.join(", ")}</span>
                )}
              </span>
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
  agents: AgentMetadataResponse[];
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
          <span className="lib-sidebar-item-meta-row">
            {a.metadata?.role && (
              <span className="lib-sidebar-item-tag">{a.metadata.role}</span>
            )}
            {a.metadata?.risk && (
              <span className={`lib-sidebar-item-tag lib-sidebar-item-tag-${a.metadata.risk}`}>
                {a.metadata.risk}
              </span>
            )}
            {a.metadata && (a.metadata.targets.length > 0) && (
              <span className="lib-sidebar-item-tag lib-sidebar-item-tag-dim">{a.metadata.targets.join(", ")}</span>
            )}
            {a.metadata && !a.metadata.safe_to_edit_runtime && (
              <span className="lib-sidebar-item-tag lib-sidebar-item-tag-warn" title="Runtime-sensitive frontmatter — edit with care">runtime</span>
            )}
          </span>
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
  bundledAgentCount,
}: {
  configTargets: AgentTargetMeta[];
  activeTargetId: string;
  onSelect: (id: string) => void;
  configContent: DocumentContent | null;
  bundledAgentCount: number;
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
            <span className="lib-sidebar-item-title">OpenCode bundle</span>
            <span className="lib-sidebar-item-desc">
              {bundledAgentCount > 0 ? `${bundledAgentCount} agents bundled` : "agents bundled"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── type helpers ──

function BrainItemList({ brainSetupSource }: { brainSetupSource: string }) {
  return (
    <div className="lib-sidebar-body">
      <div className="lib-sidebar-group">
        <div className="lib-sidebar-group-label">Source</div>
        <div className="lib-sidebar-item lib-sidebar-item-meta lib-sidebar-item-active">
          <span className="lib-sidebar-item-title">{brainSetupSource}</span>
          <span className="lib-sidebar-item-desc">copy into assistant instructions</span>
        </div>
      </div>
    </div>
  );
}

function emptyStateHint(type: LibrarySourceType): string {
  switch (type) {
    case "docs": return "Select a document to preview";
    case "rules": return "Rules template is loading";
    case "skills": return "Select a skill to preview";
    case "agents": return "Select an agent to preview";
    case "configs": return "Select a config target to preview";
    case "brain": return "Brain Setup is loading";
  }
}

// ── main view ──

export function LibraryView(props: LibraryViewProps) {
  const {
    sourceType,
    onSetSourceType,
    docs,
    docsHealth,
    onGoToWorkspaceRepair,
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
    configEditorSources,
    activeConfigSourceType,
    onSelectConfigSource,
    configEditorSourceSaveMessage,
    configEditorSourceContent,
    brainSetupText,
    brainSetupSource,
    workspaceValid,
  } = props;

  const ruleTargets = useMemo(() => agentTargets.filter((t) => t.kind === "rules"), [agentTargets]);
  const [docSearch, setDocSearch] = useState("");

  // ── derive active content for main pane ──

  let mainContent: React.ReactNode = null;

  if (sourceType === "rules" && agentTemplate) {
    mainContent = (
      <RulesContent
        agentTemplate={agentTemplate}
        onOpenTemplate={onOpenTemplate}
        agentTemplateDraft={agentTemplateDraft}
        agentTemplateDirty={agentTemplateDirty}
        agentTemplateSaving={agentTemplateSaving}
        agentTemplateSaveResult={agentTemplateSaveResult}
        agentTemplateMode={agentTemplateMode}
        onSetAgentTemplateMode={onSetAgentTemplateMode}
        onChangeAgentTemplateDraft={onChangeAgentTemplateDraft}
        onSaveAgentTemplate={onSaveAgentTemplate}
        onResetAgentTemplate={onResetAgentTemplate}
      />
    );
  } else if (sourceType === "skills" && activeSkillContent) {
    mainContent = (
      <SkillsContent
        skills={skills}
        activeSkillContent={activeSkillContent}
        onOpenSkill={onOpenSkill}
      />
    );
  } else if (sourceType === "agents" && activeAgentContent) {
    mainContent = (
      <AgentContent
        agentSources={agentSources}
        activeAgentContent={activeAgentContent}
        onOpenAgent={onOpenAgent}
        agentDraft={agentDraft}
        agentDirty={agentDirty}
        agentSaving={agentSaving}
        agentSaveResult={agentSaveResult}
        agentMode={agentMode}
        onSetAgentMode={onSetAgentMode}
        onChangeAgentDraft={onChangeAgentDraft}
        onSaveAgent={onSaveAgent}
        onResetAgent={onResetAgent}
      />
    );
  } else if (sourceType === "brain") {
    mainContent = (
      <BrainSetupContent
        workspaceValid={workspaceValid}
        brainSetupText={brainSetupText}
        brainSetupSource={brainSetupSource}
      />
    );
  } else if (sourceType === "configs" && configTemplateContent) {
    mainContent = (
      <ConfigContent
        configTemplateContent={configTemplateContent}
        activeConfigTargetId={activeConfigTargetId}
        configTargets={configTargets}
        onOpenConfig={onOpenConfig}
        configDraft={configDraft}
        configDirty={configDirty}
        configSaving={configSaving}
        configSaveResult={configSaveResult}
        configMode={configMode}
        onSetConfigMode={onSetConfigMode}
        onChangeConfigDraft={onChangeConfigDraft}
        onSaveConfig={onSaveConfig}
        onResetConfig={onResetConfig}
        agentSources={agentSources}
        configEditorSources={configEditorSources}
        activeConfigSourceType={activeConfigSourceType}
        onSelectConfigSource={onSelectConfigSource}
        configEditorSourceSaveMessage={configEditorSourceSaveMessage}
        configEditorSourceContent={configEditorSourceContent}
      />
    );
  }

  // Sidebar content per source type
  const sidebarContent = () => {
    switch (sourceType) {
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
            bundledAgentCount={agentSources.length}
          />
        );
      case "brain":
        return <BrainItemList brainSetupSource={brainSetupSource} />;
      default:
        return null;
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

  const sourceTabItems = SOURCE_TYPES.map((st) => ({
    id: st.id,
    label: st.label,
    count: sourceCount(st.id) ?? undefined,
  }));

  if (sourceType === "docs") {
    return (
      <section className="lib-frame">
        <div className="lib-docs-workspace">
          <div className="lib-docs-toolbar">
            <ToolSectionTabs
              className="lib-docs-source-tabs"
              items={sourceTabItems}
              activeId={sourceType}
              onSelect={(id) => onSetSourceType(id as LibrarySourceType)}
              ariaLabel="Library source type"
            />
          </div>
          <div className="lib-docs-body">
            <DocItemList
              docs={docs}
              docsHealth={docsHealth}
              activeId={activeDoc?.id ?? null}
              onSelect={onSelectDoc}
              workspaceValid={workspaceValid}
              onNewDoc={() => onSetShowCreateDoc(!showCreateDoc)}
              onGoToWorkspaceRepair={onGoToWorkspaceRepair}
              searchQuery={docSearch}
              onSearchQueryChange={setDocSearch}
            />
            <DocContent
              activeDoc={activeDoc}
              onOpenDoc={onOpenDoc}
              docDraft={docDraft}
              docDirty={docDirty}
              docSaving={docSaving}
              docSaveResult={docSaveResult}
              docMode={docMode}
              onSetDocMode={onSetDocMode}
              onChangeDocDraft={onChangeDocDraft}
              onSaveDoc={onSaveDoc}
              onResetDoc={onResetDoc}
              showCreateDoc={showCreateDoc}
              createDocTitle={createDocTitle}
              createDocSlug={createDocSlug}
              createDocError={createDocError}
              createDocCreating={createDocCreating}
              onSetShowCreateDoc={onSetShowCreateDoc}
              onSetCreateDocTitle={onSetCreateDocTitle}
              onSetCreateDocSlug={onSetCreateDocSlug}
              onCreateDoc={onCreateDoc}
            />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="lib-frame">
      <div className="lib-docs-workspace">
        <div className="lib-docs-toolbar">
          <ToolSectionTabs
            className="lib-docs-source-tabs"
            items={sourceTabItems}
            activeId={sourceType}
            onSelect={(id) => onSetSourceType(id as LibrarySourceType)}
            ariaLabel="Library source type"
          />
        </div>
        <div className="lib-layout lib-layout-body">
        <aside className="lib-sidebar">
          <div className="lib-sidebar-panel">
            {sidebarContent()}
          </div>
        </aside>

        <div className="lib-main">
          {mainContent ? (
            mainContent
          ) : (
            <div className="lib-main-empty">
              <span className="log-prompt">$</span>{" "}
              {workspaceValid ? emptyStateHint(sourceType) : "No valid workspace selected"}
            </div>
          )}
        </div>
        </div>
      </div>
    </section>
  );
}
