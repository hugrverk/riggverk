import type { DesignMdContent as DesignMdContentType, DesignMdInstallPlan, DesignMdInstallResult } from "../../types";
import { Markdown } from "../../components/Markdown";

interface DesignMdContentProps {
  activeContent: DesignMdContentType | null;
  installTarget: string;
  installPlan: DesignMdInstallPlan | null;
  installResult: DesignMdInstallResult | null;
  installRunning: boolean;
  onChooseTarget: () => void;
  onPlanInstall: () => void;
  onInstall: () => void;
}

export function DesignMdContent(props: DesignMdContentProps) {
  const {
    activeContent,
    installTarget,
    installPlan,
    installResult,
    installRunning,
    onChooseTarget,
    onPlanInstall,
    onInstall,
  } = props;

  if (!activeContent) {
    return (
      <div className="lib-main-empty">
        <span className="log-prompt">$</span> Select a Design MD entry
      </div>
    );
  }

  const canPlan = activeContent.slug && installTarget.trim() !== "";
  const canInstall = installPlan?.ok === true && !installRunning;
  const installDisabled = !canInstall;

  return (
    <>
      <div className="lib-editor-meta-strip">
        <div className="lib-editor-meta-left">
          <span className="lib-editor-meta-title">{activeContent.title}</span>
          <span className="lib-editor-meta-path">
            {activeContent.slug} &middot; {activeContent.path}
          </span>
        </div>
      </div>

      {/* Preview body */}
      <div className="lib-editor-body">
        <div className="lib-preview-body">
          <Markdown content={activeContent.content} />
        </div>
      </div>

      {/* Install panel */}
      <div className="design-md-install">
        <div className="design-md-install-header">
          <span className="design-md-install-title">Install DESIGN.md</span>
        </div>

        <div className="design-md-install-body">
          {/* Target folder */}
          <div className="design-md-install-row">
            <span className="design-md-install-label">Project</span>
            <div className="design-md-install-target">
              <span className={`design-md-install-path ${!installTarget ? "design-md-install-path-empty" : ""}`}>
                {installTarget || "not selected"}
              </span>
              <button className="btn btn-sm" onClick={onChooseTarget}>
                choose project
              </button>
            </div>
          </div>

          {/* Actions */}
          <div className="design-md-install-actions">
            <button className="btn btn-sm" onClick={onPlanInstall} disabled={!canPlan}>
              dry run
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={onInstall}
              disabled={installDisabled}
            >
              {installRunning ? "installing..." : "install DESIGN.md"}
            </button>
          </div>

          {/* Install plan */}
          {installPlan && (
            <div className={`design-md-install-plan ${installPlan.ok ? "design-md-install-plan-ok" : "design-md-install-plan-blocked"}`}>
              <div className="design-md-plan-row">
                <span className="design-md-plan-key">action</span>
                <span className={`design-md-plan-value design-md-plan-action-${installPlan.action}`}>
                  {installPlan.action === "create"
                    ? "will create DESIGN.md"
                    : installPlan.action === "replace_with_backup"
                    ? "will replace DESIGN.md after backup"
                    : "blocked"}
                </span>
              </div>
              <div className="design-md-plan-row">
                <span className="design-md-plan-key">target</span>
                <span className="design-md-plan-value">{installPlan.target_file}</span>
              </div>
              {installPlan.backup_path && (
                <div className="design-md-plan-row">
                  <span className="design-md-plan-key">backup</span>
                  <span className="design-md-plan-value">{installPlan.backup_path}</span>
                </div>
              )}
              {installPlan.existing && installPlan.existing_size != null && (
                <div className="design-md-plan-row">
                  <span className="design-md-plan-key">existing</span>
                  <span className="design-md-plan-value">{installPlan.existing_size} bytes</span>
                </div>
              )}
              <div className="design-md-plan-row">
                <span className="design-md-plan-key">reason</span>
                <span className="design-md-plan-value">{installPlan.reason}</span>
              </div>
              {installPlan.warnings.length > 0 && (
                <div className="design-md-plan-warnings">
                  {installPlan.warnings.map((w, i) => (
                    <div key={i} className="design-md-plan-warning">{w}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Install result */}
          {installResult && (
            <div className={`design-md-install-result ${installResult.success ? "design-md-install-result-ok" : "design-md-install-result-fail"}`}>
              <div className="design-md-plan-row">
                <span className="design-md-plan-key">status</span>
                <span className="design-md-plan-value">{installResult.message}</span>
              </div>
              <div className="design-md-plan-row">
                <span className="design-md-plan-key">file</span>
                <span className="design-md-plan-value">{installResult.target_file}</span>
              </div>
              {installResult.backup_path && (
                <div className="design-md-plan-row">
                  <span className="design-md-plan-key">backup</span>
                  <span className="design-md-plan-value">{installResult.backup_path}</span>
                </div>
              )}
              {installResult.warnings.length > 0 && (
                <div className="design-md-plan-warnings">
                  {installResult.warnings.map((w, i) => (
                    <div key={i} className="design-md-plan-warning">{w}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
