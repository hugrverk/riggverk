import { useShellState } from "./ShellState";

/**
 * The transient notice (`notify`), bottom centre. The live region is always mounted so a new notice is announced
 * politely; the pill exists only while a notice does. It is `pointer-events: none` and never takes focus.
 * An identical repeat restarts the entrance (keyed by the notice id).
 */
export function Toast() {
  const { notice, noticeTone, noticeId } = useShellState();
  return (
    <div className="toast" role="status">
      {notice && (
        <span key={noticeId} className="toast-text" data-tone={noticeTone ?? undefined}>
          {notice}
        </span>
      )}
    </div>
  );
}
