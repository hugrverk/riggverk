import type { DesignMdContent as DesignMdContentType, DesignMdInstallPlan, DesignMdInstallResult, DesignMdInstallStatus } from "../../types";
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
  installStatus: DesignMdInstallStatus | null;
  onOpenTargetFolder: () => void;
  onOpenInstalledDesignMd: () => void;
}

function statusLabel(status: string): string {
  switch (status) {
    case "no_target": return "no project selected";
    case "missing": return "not installed";
    case "installed": return "installed";
    case "different": return "different DESIGN.md";
    case "blocked": return "blocked";
    default: return status;
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "installed": return "design-md-status-installed";
    case "different": return "design-md-status-different";
    case "missing": return "design-md-status-missing";
    case "blocked": return "design-md-status-blocked";
    default: return "";
  }
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
    installStatus,
    onOpenTargetFolder,
    onOpenInstalledDesignMd,
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
  const targetExists = installStatus?.exists === true;
  const hasTarget = installTarget.trim() !== "";

  let disabledHint: string | null = null;
  if (!installTarget) {
    disabledHint = "choose a project";
  } else if (!installPlan && canPlan) {
    if (installStatus?.status === "different") {
      disabledHint = "dry run will plan backup + replace";
    } else {
      disabledHint = "dry run required";
    }
  }

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
          {/* Target folder row */}
          <div className="design-md-install-row">
            <span className="design-md-install-label">Project</span>
            <div className="design-md-install-target">
              <span
                className={`design-md-install-path ${!installTarget ? "design-md-install-path-empty" : ""}`}
                title={installTarget || undefined}
              >
                {installTarget || "not selected"}
              </span>
              <button className="btn btn-sm" onClick={onChooseTarget} aria-label="Choose project folder">
                choose project
              </button>
              {hasTarget && (
                <button
                  className="btn btn-sm"
                  onClick={onOpenTargetFolder}
                  title="Open project folder"
                  aria-label="Open project folder"
                >
                  open folder
                </button>
              )}
            </div>
          </div>

          {/* Install status row */}
          {installStatus && (
            <div className="design-md-install-row">
              <span className="design-md-install-label">Status</span>
              <span className={`design-md-install-status ${statusClass(installStatus.status)}`}>
                {statusLabel(installStatus.status)}
              </span>
              {installStatus.exists && installStatus.size != null && (
                <span className="design-md-install-status-meta">{installStatus.size} bytes</span>
              )}
            </div>
          )}

          {/* Actions row */}
          <div className="design-md-install-actions">
            <button className="btn btn-sm" onClick={onPlanInstall} disabled={!canPlan}>
              dry run
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={onInstall}
              disabled={!canInstall}
            >
              {installRunning ? "installing..." : "install DESIGN.md"}
            </button>
            {targetExists && (
              <button
                className="btn btn-sm"
                onClick={onOpenInstalledDesignMd}
                title="Open installed DESIGN.md"
                aria-label="Open installed DESIGN.md"
              >
                open DESIGN.md
              </button>
            )}
          </div>

          {disabledHint && (
            <span className="design-md-install-hint">{disabledHint}</span>
          )}

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
