import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { ReleaseNotes } from "../lib/releaseNotes";
import { TButton } from "../ui/TButton";
import { scrollHelpBox, trapTab, useRestoreFocus } from "./overlay";
import { useShellState } from "./ShellState";

/**
 * "What's new" overlay, built like the `?` help overlay (same backdrop, box and key rows): the notes of the
 * releases it was opened with, newest first. Esc or q closes it; j/k and the paging keys scroll.
 */
export function WhatsNewOverlay() {
  const { whatsNew } = useShellState();
  return whatsNew ? <WhatsNewBody releases={whatsNew.releases} /> : null;
}

function WhatsNewBody({ releases }: { releases: readonly ReleaseNotes[] }) {
  const { closeWhatsNew } = useShellState();
  const dialogRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useRestoreFocus();

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "q") {
      event.preventDefault();
      closeWhatsNew();
      return;
    }
    if (scrollHelpBox(boxRef.current, event)) {
      event.preventDefault();
      return;
    }
    trapTab(event, dialogRef.current);
  };

  return (
    <div
      ref={dialogRef}
      className="help-overlay whatsnew"
      role="dialog"
      aria-modal="true"
      aria-label="What's new"
      tabIndex={-1}
      data-keyscope="overlay"
      onKeyDown={onKeyDown}
      onMouseDown={event => {
        if (event.target === event.currentTarget) closeWhatsNew();
      }}
    >
      <div ref={boxRef} className="help-box">
        <h2>What&apos;s new</h2>
        <div className="help-cols">
          {releases.map(release => (
            <section key={release.version} aria-label={release.version}>
              <h3 className="group">{release.version}</h3>
              <dl className="kv">
                {release.sections.flatMap(section =>
                  section.items.map((item, index) => (
                    <WhatsNewRow key={`${section.title}\u0000${index}`} label={section.title} text={item} />
                  )),
                )}
              </dl>
            </section>
          ))}
        </div>
        <p className="foot">
          <TButton keys={["esc"]} onClick={closeWhatsNew}>
            close
          </TButton>
        </p>
      </div>
    </div>
  );
}

function WhatsNewRow({ label, text }: { label: string; text: string }) {
  return (
    <>
      <dt className="c-dim">{label.toLowerCase()}</dt>
      <dd>{inlineMarkdown(text)}</dd>
    </>
  );
}

const INLINE_MARK = /(`[^`]+`|\*\*[^*]+\*\*)/;

/** The Markdown the release notes use inside a line: `code` and **bold**. Anything else stays as written. */
function inlineMarkdown(text: string): ReactNode[] {
  return text.split(INLINE_MARK).map((part, index) => {
    if (index % 2 === 0) return part;
    return part.startsWith("`") ? (
      <code key={index} className="markdown-inline-code">
        {part.slice(1, -1)}
      </code>
    ) : (
      <strong key={index}>{part.slice(2, -2)}</strong>
    );
  });
}
