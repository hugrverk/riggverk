import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AppUpdate } from "../hooks/useAppUpdate";
import { TButton } from "../ui/TButton";
import { scrollHelpBox, trapTab, useRestoreFocus } from "./overlay";

/**
 * Asked once, in the sidebar foot, before the app ever looks for a new version. Nothing is requested until the
 * user chooses; "Not now" leaves only Check for Updates in the menu and Settings.
 */
export function UpdateConsentCard({ update }: { update: AppUpdate }) {
  if (!update.consentNeeded) return null;
  return (
    <section className="update-card" aria-label="Check for new versions">
      <p className="update-card-title">Check for new versions?</p>
      <p className="update-card-text">
        Riggverk can ask github.com once a day. It sends no data about you or your setup.
      </p>
      <div className="update-card-actions">
        <TButton keys={[]} variant="primary" onClick={update.chooseDaily}>
          Check daily
        </TButton>
        <TButton keys={[]} onClick={update.notNow}>
          Not now
        </TButton>
      </div>
    </section>
  );
}

/** "· New: <version>" after the version in the sidebar foot; opens the review. */
export function UpdateFootLink({ update }: { update: AppUpdate }) {
  if (!update.available) return null;
  return (
    <button type="button" className="update-foot-link" onClick={update.openReview}>
      New: {update.available.version}
    </button>
  );
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The review of a new version, built like the what's new overlay: the version, its notes as text, the app it
 * replaces, and one button, "Download and restart". Also the answer to a check the user asked for (up to date, or
 * the error). Esc closes it, except while the new version is being installed.
 */
export function AppUpdateOverlay({ update }: { update: AppUpdate }) {
  if (!update.review) return null;
  return <AppUpdateBody update={update} />;
}

function AppUpdateBody({ update }: { update: AppUpdate }) {
  const review = update.review!;
  const dialogRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useRestoreFocus();

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const available = review.kind === "available" ? review.update : null;
  const blocked: string | false = available ? (available.blocked ?? update.installBlocked) : false;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "q") {
      event.preventDefault();
      update.closeReview();
      return;
    }
    if (scrollHelpBox(boxRef.current, event)) {
      event.preventDefault();
      return;
    }
    trapTab(event, dialogRef.current);
  };

  const progress = update.progress;
  const progressText = !update.installing
    ? null
    : progress?.phase === "install"
      ? "Replacing the app…"
      : progress
        ? `Downloading ${formatBytes(progress.downloaded)}${progress.total ? ` of ${formatBytes(progress.total)}` : ""}…`
        : "Downloading…";

  return (
    <div
      ref={dialogRef}
      className="help-overlay whatsnew app-update"
      role="dialog"
      aria-modal="true"
      aria-label={available ? `Riggverk ${available.version}` : "Check for updates"}
      tabIndex={-1}
      data-keyscope="overlay"
      onKeyDown={onKeyDown}
      onMouseDown={event => {
        if (event.target === event.currentTarget) update.closeReview();
      }}
    >
      <div ref={boxRef} className="help-box">
        {review.kind === "up_to_date" && (
          <>
            <h2>Check for updates</h2>
            <p className="app-update-text">Riggverk {review.version} is the newest version.</p>
          </>
        )}
        {review.kind === "error" && (
          <>
            <h2>Check for updates</h2>
            <p className="app-update-text c-fail" role="alert">
              {review.message}
            </p>
          </>
        )}
        {available && (
          <>
            <h2>New version: {available.version}</h2>
            <dl className="kv app-update-facts">
              <dt className="c-dim">installed</dt>
              <dd>{available.current_version}</dd>
              {available.app_path && (
                <>
                  <dt className="c-dim">replaces</dt>
                  <dd>{available.app_path}</dd>
                </>
              )}
            </dl>
            <pre className="app-update-notes">{available.notes?.trim() || "No release notes."}</pre>
            <p className="app-update-text c-dim">
              Your rules, skills and backups are not touched; only the app is replaced.
            </p>
            {blocked && (
              <p className="app-update-text c-fail" role="status">
                {blocked}
              </p>
            )}
            <div role="status" aria-live="polite" className="app-update-text">
              {progressText}
              {update.installError && <span className="c-fail">{update.installError}</span>}
            </div>
          </>
        )}
        <p className="foot">
          {available && (
            <TButton
              keys={[]}
              variant="primary"
              disabled={blocked || (update.installing ? "Installing…" : false)}
              onClick={update.install}
            >
              Download and restart
            </TButton>
          )}{" "}
          <TButton keys={["esc"]} disabled={update.installing ? "Installing…" : false} onClick={update.closeReview}>
            {available ? "not now" : "close"}
          </TButton>
        </p>
      </div>
    </div>
  );
}
