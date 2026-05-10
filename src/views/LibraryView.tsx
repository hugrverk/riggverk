import { useMemo } from "react";
import type { ActionResult } from "../components/TerminalOutput";
import type {
  AgentMetadataResponse,
  AgentSourceContent,
  AgentTargetMeta,
  DesignMdCatalogStatus,
  DesignMdContent,
  DesignMdEntry,
  DesignMdSyncResult,
  DocSummary,
  DocumentContent,
  SkillSummary,
} from "../types";
import { DocContent } from "./library/DocContent";
import { RulesContent } from "./library/RulesContent";
import { SkillsContent } from "./library/SkillsContent";
import { AgentContent } from "./library/AgentContent";
import { ConfigContent } from "./library/ConfigContent";
import { DesignMdContent as DesignMdContentPanel } from "./library/DesignMdContent";
import { designMdDisplayTitle, designMdHasInspiredTitle, designMdSearchText } from "../lib/designMdDisplay";

export type LibrarySourceType = "docs" | "rules" | "skills" | "agents" | "configs" | "designMd";

const SOURCE_TYPES: { id: LibrarySourceType; label: string }[] = [
  { id: "docs", label: "Docs" },
  { id: "rules", label: "Rules" },
  { id: "skills", label: "Skills" },
  { id: "agents", label: "Agents" },
  { id: "configs", label: "Configs" },
  { id: "designMd", label: "Design MD" },
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

  // Common
  workspaceValid: boolean;

  // Design MD
  designMdCatalogStatus: DesignMdCatalogStatus | null;
  designMdEntries: DesignMdEntry[];
  activeDesignMdSlug: string | null;
  activeDesignMdContent: DesignMdContent | null;
  designMdSearch: string;
  onSetDesignMdSearch: (value: string) => void;
  designMdSyncResult: DesignMdSyncResult | null;
  designMdSyncRunning: boolean;
  onSyncDesignMdCatalog: () => void;
  onSelectDesignMdEntry: (slug: string) => void;
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
            <span className="lib-sidebar-item-title">Config + Agents</span>
            <span className="lib-sidebar-item-desc">
              {bundledAgentCount > 0 ? `${bundledAgentCount} agents bundled` : "agents bundled"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Design MD sidebar ──

function DesignMdSidebarInner({
  catalogStatus,
  entries,
  activeSlug,
  onSelect,
  search,
  onSearch,
  syncRunning,
  onSync,
  syncResult,
}: {
  catalogStatus: DesignMdCatalogStatus | null;
  entries: DesignMdEntry[];
  activeSlug: string | null;
  onSelect: (slug: string) => void;
  search: string;
  onSearch: (v: string) => void;
  syncRunning: boolean;
  onSync: () => void;
  syncResult: DesignMdSyncResult | null;
}) {
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return entries;
    return entries.filter((e) => designMdSearchText(e).includes(q));
  }, [entries, search]);

  const notSynced = !catalogStatus || !catalogStatus.exists;

  return (
    <div className="lib-sidebar-body">
      <div className="lib-sidebar-search">
        {notSynced ? (
          <button
            className="btn btn-primary btn-sm design-md-sync-wide"
            onClick={onSync}
            disabled={syncRunning}
          >
            {syncRunning ? "syncing..." : "sync catalog"}
          </button>
        ) : (
          <>
            <input
              className="lib-search-input"
              type="text"
              placeholder="search entries..."
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              aria-label="Search Design MD entries"
            />
            {search && (
              <button className="btn btn-sm lib-search-clear" onClick={() => onSearch("")} aria-label="Clear search">clear</button>
            )}
            <button
              className="btn btn-sm"
              onClick={onSync}
              disabled={syncRunning}
              title="Re-sync catalog"
              aria-label="Re-sync catalog"
            >
              {syncRunning ? "..." : "sync"}
            </button>
          </>
        )}
      </div>
      {syncResult && (
        <div className={`design-md-sync-result ${syncResult.success ? "design-md-sync-result-ok" : "design-md-sync-result-fail"}`}>
          <span className="design-md-sync-result-key">sync</span>
          <span className="design-md-sync-result-val">{syncResult.action}</span>
          <span className="design-md-sync-result-key">entries</span>
          <span className="design-md-sync-result-val">{syncResult.entry_count}</span>
          {syncResult.current_commit && (
            <>
              <span className="design-md-sync-result-key">commit</span>
              <span className="design-md-sync-result-val">{syncResult.current_commit.slice(0, 7)}</span>
            </>
          )}
          {!syncResult.success && syncResult.stderr && (
            <span className="design-md-sync-stderr">
              {syncResult.stderr.slice(0, 120)}
            </span>
          )}
        </div>
      )}
      {notSynced ? (
        <div className="lib-sidebar-empty">Catalog not synced</div>
      ) : filtered.length === 0 ? (
        <div className="lib-sidebar-empty">
          {search ? "No matches" : "No Design MD entries found"}
        </div>
      ) : (
        <div className="lib-sidebar-list">
          {filtered.map((e) => (
            (() => {
              const displayTitle = designMdDisplayTitle(e.slug);
              const inspired = designMdHasInspiredTitle(e.title);
              return (
            <button
              key={e.slug}
              className={`lib-sidebar-item ${activeSlug === e.slug ? "lib-sidebar-item-active" : ""}`}
              onClick={() => onSelect(e.slug)}
              aria-current={activeSlug === e.slug ? "true" : undefined}
            >
              <span className="lib-sidebar-item-title">{displayTitle}</span>
              <span className="lib-sidebar-item-desc">{e.description || e.slug}</span>
              {inspired && (
                <span className="lib-sidebar-item-meta-row">
                  <span className="lib-sidebar-item-tag lib-sidebar-item-tag-dim">inspired</span>
                </span>
              )}
            </button>
              );
            })()
          ))}
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
    case "designMd": return "Design MD";
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
    designMdCatalogStatus,
    designMdEntries,
    activeDesignMdSlug,
    activeDesignMdContent,
    designMdSearch,
    onSetDesignMdSearch,
    designMdSyncResult,
    designMdSyncRunning,
    onSyncDesignMdCatalog,
    onSelectDesignMdEntry,
  } = props;

  const ruleTargets = useMemo(() => agentTargets.filter((t) => t.kind === "rules"), [agentTargets]);

  // ── derive active content for main pane ──

  let mainContent: React.ReactNode = null;

  if (sourceType === "docs" && activeDoc) {
    mainContent = (
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
    );
  } else if (sourceType === "rules" && agentTemplate) {
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
      />
    );
  } else if (sourceType === "designMd" && activeDesignMdContent) {
    mainContent = (
      <DesignMdContentPanel
        activeContent={activeDesignMdContent}
      />
    );
  } else if (sourceType === "designMd" && !designMdCatalogStatus?.exists) {
    // Catalog not synced — show prompt
    mainContent = (
      <div className="lib-main-empty design-md-empty-stack">
        <span><span className="log-prompt">$</span> Design MD catalog not synced</span>
        <button
          className="btn btn-primary btn-sm"
          onClick={onSyncDesignMdCatalog}
          disabled={designMdSyncRunning}
        >
          {designMdSyncRunning ? "syncing..." : "sync catalog"}
        </button>
      </div>
    );
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
            bundledAgentCount={agentSources.length}
          />
        );
      case "designMd":
        return (
          <DesignMdSidebarInner
            catalogStatus={designMdCatalogStatus}
            entries={designMdEntries}
            activeSlug={activeDesignMdSlug}
            onSelect={onSelectDesignMdEntry}
            search={designMdSearch}
            onSearch={onSetDesignMdSearch}
            syncRunning={designMdSyncRunning}
            onSync={onSyncDesignMdCatalog}
            syncResult={designMdSyncResult}
          />
        );
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
      case "designMd": return designMdEntries.length > 0 ? String(designMdEntries.length) : null;
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
        <nav className="lib-source-rail" aria-label="Source type">
          {SOURCE_TYPES.map((st) => {
            const count = sourceCount(st.id);
            return (
              <button
                key={st.id}
                className={`lib-source-rail-btn ${sourceType === st.id ? "lib-source-rail-btn-active" : ""}`}
                onClick={() => onSetSourceType(st.id)}
                aria-current={sourceType === st.id ? "page" : undefined}
                title={`${st.label}${count ? ` (${count})` : ""}`}
              >
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
