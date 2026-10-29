import { useId } from "react";

export interface TopBarProps {
  /** Name of the current view, the end of the crumb. */
  viewLabel: string;
  /** Re-checks every agent (the same refresh as `:refresh`). */
  onCheck: () => void;
  /** Opens the install review of everything enabled. Nothing is written until it is applied there. */
  onUpdateAll: () => void;
  /** Why Update all cannot run right now, or false. */
  updateAllDisabled?: string | false;
  /** A check is running. */
  checking?: boolean;
}

/**
 * 54px top bar and window drag region: the crumb, Check (secondary) and Update all (primary). A disabled Update
 * all stays focusable (`aria-disabled`) so its reason is readable as the tooltip and by assistive technology; it
 * never runs while disabled.
 */
export function TopBar({ viewLabel, onCheck, onUpdateAll, updateAllDisabled = false, checking = false }: TopBarProps) {
  const reasonId = useId();
  return (
    <header className="bar shell-chrome" data-tauri-drag-region>
      <span className="crumb" data-tauri-drag-region>
        Riggverk / {viewLabel}
      </span>
      <button type="button" className="b s" aria-busy={checking || undefined} onClick={onCheck}>
        Check
      </button>
      <button
        type="button"
        className="b p"
        aria-disabled={updateAllDisabled ? true : undefined}
        aria-describedby={updateAllDisabled ? reasonId : undefined}
        title={updateAllDisabled || "Review every update, then apply"}
        onClick={() => {
          if (!updateAllDisabled) onUpdateAll();
        }}
      >
        Update all
      </button>
      {updateAllDisabled && (
        <span id={reasonId} className="visually-hidden">
          {updateAllDisabled}
        </span>
      )}
    </header>
  );
}
