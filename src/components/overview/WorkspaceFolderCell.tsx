import { useEffect, useId, useState } from "react";
import { dataFolderReason, type DataFolderVerdict } from "../../lib/installationView";
import type { WorkspaceItemModel } from "../../lib/overviewModel";
import { UI_STATE_LABEL } from "../../lib/uiState";
import type { DataFolderStatus, WorkspaceDiagnostics } from "../../types";
import { Kv, type KvItem } from "../../ui/Kv";
import { StatePill } from "../../ui/StatePill";
import { TButton } from "../../ui/TButton";
import { UninstallCard } from "../UninstallCard";
import { UninstallRecoveryCard } from "../UninstallRecoveryCard";

export interface WorkspaceFolderCellProps {
  workspace: WorkspaceItemModel;
  /** Where the workspace lives, as the diagnostics resolve it. */
  path: string;
  diagnostics: Pick<WorkspaceDiagnostics, "error" | "layout_notes"> | null;
  dataFolderOk: boolean;
  dataFolderVerdict?: DataFolderVerdict;
  /** What the app keeps in the folder (the workspace surface's `data_folder`); null while unknown. */
  dataFolder: DataFolderStatus | null;
  backupCount: number;
  backupRoot: string | null;
  /** Transaction the last install or uninstall left in this session, if it can still be rolled back. */
  rollbackTransactionId: string | null;
  /** Label of the workspace task in flight, or null. */
  wsRunning: string | null;
  onOpenFolder: () => void;
  onOpenBackupsFolder: () => void;
  onUninstall: (planFingerprint: string, previewToken: string) => void;
  uninstallRecoveryTransactionId: string | null;
  onUninstallRollback: () => Promise<boolean>;
  /** `:uninstall` asks for the preview dialog; the cell opens so the card that handles the request is mounted. */
  uninstallPreviewRequested: boolean;
  onUninstallPreviewHandled: () => void;
}

/**
 * The workspace folder, collapsed: its state, its path and anything it needs you to know (why it is unusable, what an
 * earlier release left behind) stay in view; the facts about it, the folder and backups buttons (`o`, `B`) and the
 * uninstall and recovery cards sit behind a disclosure. A pending `:uninstall` request or an uninstall to recover
 * opens it on its own, so the card that handles them is on screen.
 */
export function WorkspaceFolderCell({
  workspace,
  path,
  diagnostics,
  dataFolderOk,
  dataFolderVerdict,
  dataFolder,
  backupCount,
  backupRoot,
  rollbackTransactionId,
  wsRunning,
  onOpenFolder,
  onOpenBackupsFolder,
  onUninstall,
  uninstallRecoveryTransactionId,
  onUninstallRollback,
  uninstallPreviewRequested,
  onUninstallPreviewHandled,
}: WorkspaceFolderCellProps) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const busy = wsRunning !== null;
  const state = workspace.item.state;

  useEffect(() => {
    if (uninstallPreviewRequested || uninstallRecoveryTransactionId) setExpanded(true);
  }, [uninstallPreviewRequested, uninstallRecoveryTransactionId]);

  // The state's own sentence ("133 old copies to remove"; why the folder is unusable: a link, a file, a missing override
  // folder), then a folder move from an earlier release that was not done, or an earlier folder left next to this one.
  const notes = [...(workspace.subline ? [workspace.subline] : []), ...(diagnostics?.layout_notes ?? [])];

  const facts: KvItem[] = [
    ...(dataFolder
      ? [
          { label: "personal docs", value: String(dataFolder.personal_docs), tone: dataFolder.personal_docs > 0 ? undefined : ("dim" as const) },
          {
            label: "ownership records",
            value: dataFolder.ownership_records ? "present" : "none yet",
            tone: dataFolder.ownership_records ? undefined : ("dim" as const),
          },
          ...(dataFolder.left_in_place > 0
            ? [{ label: "left in place", value: `${dataFolder.left_in_place} · edited old copies the app no longer reads`, wrap: true }]
            : []),
        ]
      : []),
    {
      label: "backups",
      value: `${backupCount} run${backupCount === 1 ? "" : "s"}${backupRoot ? ` · ${backupRoot}` : ""}`,
      tone: backupCount > 0 ? undefined : "dim",
      wrap: true,
    },
    {
      label: "last transaction",
      value: rollbackTransactionId ? `${rollbackTransactionId} · rollback available` : "none this session",
      tone: rollbackTransactionId ? undefined : "dim",
      wrap: true,
    },
  ];

  return (
    <section className="ov-cell ov-span3 ov-folder" aria-label="Workspace folder">
      <button
        type="button"
        className="ov-fold"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={() => setExpanded(open => !open)}
      >
        <span className="ov-lbl">Workspace folder</span>
        <span className="ov-fold-path">{path}</span>
        {state && <StatePill state={state}>{UI_STATE_LABEL[state]}</StatePill>}
        <span className="ov-chev" aria-hidden="true" />
      </button>
      {notes.map((note, index) => (
        <p key={index} className="ov-note">
          {note}
        </p>
      ))}
      {expanded && (
        <div id={bodyId} className="ov-fold-body">
          <Kv items={facts} className="ov-kv" aria-label="Workspace folder facts" />
          <div className="ov-actions">
            <TButton
              keys={["o"]}
              shortcut="o"
              disabled={!dataFolderOk ? dataFolderReason(dataFolderVerdict) : busy ? `${wsRunning} is running` : false}
              onClick={onOpenFolder}
            >
              Open folder
            </TButton>
            <TButton keys={["B"]} shortcut="B" disabled={busy ? `${wsRunning} is running` : false} onClick={onOpenBackupsFolder}>
              Backups folder
            </TButton>
          </div>
          {(dataFolderOk || uninstallRecoveryTransactionId) && (
            <>
              <UninstallCard
                dataFolderOk={dataFolderOk}
                busy={busy}
                onApply={onUninstall}
                previewRequested={uninstallPreviewRequested}
                onPreviewRequestHandled={onUninstallPreviewHandled}
              />
              <UninstallRecoveryCard transactionId={uninstallRecoveryTransactionId} busy={busy} onRollback={onUninstallRollback} />
            </>
          )}
        </div>
      )}
    </section>
  );
}
