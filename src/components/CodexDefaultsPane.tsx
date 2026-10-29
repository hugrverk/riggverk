import { useEffect } from "react";
import { defaultsKeyList, type CodexDefaultsFlow } from "../hooks/useCodexDefaultsFlow";
import { focusDefaultPane, focusPaneById } from "../keyboard/focus";
import type { Binding } from "../keyboard/registry";
import { useKeymap } from "../keyboard/useKeymap";
import { BindingButton } from "../ui/BindingButton";
import { Kv, type KvItem } from "../ui/Kv";
import { Pane } from "../ui/Pane";
import type { CodexConfigDefaultsPreview } from "../types";
import { DiffView } from "./DiffView";
import { ReviewFooter } from "./ReviewFooter";
import { ActivityLoader } from "./TerminalOutput";

export const CODEX_DEFAULTS_PANE_ID = "codex-defaults";

export interface CodexDefaultsPaneProps {
  flow: CodexDefaultsFlow;
  /** Label of an unrelated workspace task that is running; apply waits for it. */
  busyLabel: string | null;
  /** Where backups are written, for the note under the preview. */
  backupRoot?: string | null;
  /** The pane that takes the keyboard back when the review closes. Default `page`. */
  returnPaneId?: string;
}

const ERROR_HINT = {
  preview: "The preview could not be computed. Nothing was written.",
  apply: "The backend refused this change before it ran. Nothing was written; preview again to review the config as it is now.",
} as const;

function scrollBody(to: "top" | "bottom" | number) {
  const body = document.querySelector<HTMLElement>(`[data-pane-id="${CODEX_DEFAULTS_PANE_ID}"] .pane-body`);
  if (!body) return;
  if (typeof to === "number") body.scrollBy?.({ top: to });
  else body.scrollTo?.({ top: to === "top" ? 0 : body.scrollHeight });
}

function PreviewBody({ preview }: { preview: CodexConfigDefaultsPreview }) {
  const items: KvItem[] = [
    ...preview.keys.map((item): KvItem => ({
      id: item.key,
      label: item.key,
      value: `${item.yours === "" ? "(not set)" : item.yours} → ${item.riggverk}`,
      wrap: true,
    })),
    {
      id: "leaves",
      label: "leaves",
      value: "everything else in config.toml: your other keys, comments and the other managed keys are not touched",
      tone: "dim",
      wrap: true,
    },
  ];
  return (
    <>
      <Kv items={items} aria-label="Keys set to Riggverk's values" />
      <div className="group pane-group">diff: your values → Riggverk’s</div>
      <DiffView diff={preview.diff} label="Diff: your Codex config keys to Riggverk’s values" empty="no differences" />
    </>
  );
}

/**
 * The "Use Riggverk defaults" review: a sub-state of the Codex page in place of its cells. It previews setting the
 * enforced keys that differ to Riggverk's values: the keys, your value and Riggverk's, and a key-only diff. Nothing is
 * written until `y`; the backend backs up config.toml first and refuses a stale fingerprint or an expired token.
 *
 * Keys (focus inside the pane): `y` apply, `n`/Esc close, `r` open the review again after an error, `j`/`k`/`g g`/`G`
 * scroll. Enter never applies.
 */
export function CodexDefaultsPane({ flow, busyLabel, backupRoot, returnPaneId = "page" }: CodexDefaultsPaneProps) {
  const { state } = flow;
  const open = state.status !== "idle";

  // Take focus when the review appears, unless the user already moved somewhere deliberate.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const pane = document.querySelector(`[data-pane-id="${CODEX_DEFAULTS_PANE_ID}"]`);
    const free = !active || active === document.body || !active.isConnected || pane?.contains(active) === true;
    if (free) focusPaneById(CODEX_DEFAULTS_PANE_ID);
  }, [open, state.status]);

  // When the review closes the page comes back; hand the keyboard to it instead of leaving it on the body.
  useEffect(
    () => () => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) {
        if (!focusPaneById(returnPaneId)) focusDefaultPane();
      }
    },
    [returnPaneId],
  );

  const applyState = (): boolean | string => {
    if (state.status === "applying") return "applying…";
    if (state.status !== "preview") return false;
    if (!state.preview.plan_fingerprint || !state.preview.preview_token) return "the preview has no token; open it again";
    if (busyLabel) return `${busyLabel} is running`;
    return true;
  };
  const closeState = (): boolean | string => (state.status === "applying" ? "applying; it cannot be cancelled" : open);

  // The confirm line's buttons run these two: the very bindings the keys fire.
  const applyAction: Binding = {
    id: "codex-defaults.apply",
    keys: "y",
    title: "Set the Codex config keys to Riggverk's values as previewed",
    hint: "apply",
    group: "Codex config review",
    scope: "pane",
    paneId: CODEX_DEFAULTS_PANE_ID,
    when: applyState,
    run: () => flow.apply(),
  };
  const closeAction: Binding = {
    id: "codex-defaults.close",
    keys: ["n", "Escape"],
    title: "Close the Codex config review",
    hint: "cancel",
    group: "Codex config review",
    scope: "pane",
    paneId: CODEX_DEFAULTS_PANE_ID,
    when: closeState,
    run: () => flow.close(),
  };

  const retryAction: Binding = {
    id: "codex-defaults.retry",
    keys: "r",
    title: "Open the review again",
    hint: "again",
    group: "Codex config review",
    scope: "pane",
    paneId: CODEX_DEFAULTS_PANE_ID,
    when: () => state.status === "error",
    run: () => void flow.retry(),
  };

  const actions: Binding[] = [
    applyAction,
    closeAction,
    retryAction,
    { id: "codex-defaults.down", keys: ["j", "ArrowDown"], title: "Scroll down", group: "Codex config review", scope: "pane", paneId: CODEX_DEFAULTS_PANE_ID, repeat: true, run: () => scrollBody(60) },
    { id: "codex-defaults.up", keys: ["k", "ArrowUp"], title: "Scroll up", group: "Codex config review", scope: "pane", paneId: CODEX_DEFAULTS_PANE_ID, repeat: true, run: () => scrollBody(-60) },
    { id: "codex-defaults.top", keys: ["g g", "Home"], title: "Scroll to top", group: "Codex config review", scope: "pane", paneId: CODEX_DEFAULTS_PANE_ID, run: () => scrollBody("top") },
    { id: "codex-defaults.bottom", keys: ["G", "End"], title: "Scroll to bottom", group: "Codex config review", scope: "pane", paneId: CODEX_DEFAULTS_PANE_ID, run: () => scrollBody("bottom") },
    {
      // Escape closes from anywhere while the review is open, not only from inside the pane.
      id: "codex-defaults.close.escape",
      keys: "Escape",
      title: "Close the Codex config review",
      group: "Codex config review",
      scope: "global",
      when: () => open && state.status !== "applying",
      run: () => flow.close(),
    },
  ];
  useKeymap(actions);

  const preview = state.status === "preview" || state.status === "applying" ? state.preview : null;
  const keys = preview ? defaultsKeyList(preview) : "";
  const question =
    state.status === "loading"
      ? "computing the preview for the Codex config…"
      : state.status === "applying"
        ? "applying: backing up, then writing…"
        : state.status === "error"
          ? "nothing was written"
          : state.status === "preview"
            ? `set ${keys} to Riggverk’s ${preview && preview.keys.length === 1 ? "value" : "values"}?`
            : "";

  return (
    <Pane
      id={CODEX_DEFAULTS_PANE_ID}
      title="Config review"
      label="Config review"
      variant="card"
      scrollable
      defaultFocus
      meta={preview ? `use Riggverk defaults · ${keys}` : "use Riggverk defaults"}
      footer={
        <ReviewFooter question={question} backup={preview !== null && { root: backupRoot }}>
          <BindingButton binding={applyAction} apply />
          <BindingButton binding={retryAction} label="try again" />
          <BindingButton binding={closeAction} />
        </ReviewFooter>
      }
    >
      {state.status === "loading" && (
        <div className="plan-state" role="status">
          <ActivityLoader />
          <span className="c-dim">computing the preview for the Codex config…</span>
        </div>
      )}
      {state.status === "error" && (
        <div className="plan-state">
          <p className="rv-error" role="alert">
            <span className="rv-mark rv-mark-remove" aria-hidden="true" />
            {state.message}
          </p>
          <p className="c-dim">{ERROR_HINT[state.what]}</p>
        </div>
      )}
      {preview && <PreviewBody preview={preview} />}
    </Pane>
  );
}
