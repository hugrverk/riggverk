import { useEffect, useRef, type KeyboardEvent } from "react";
import { focusPaneById } from "../../keyboard/focus";

interface CreateDocFormProps {
  title: string;
  slug: string;
  error: string | null;
  creating: boolean;
  onSetShow: (show: boolean) => void;
  onSetTitle: (value: string) => void;
  onSetSlug: (value: string) => void;
  onCreate: () => void;
}

/** New custom doc (docs/context/<slug>.md). Opens with the title field focused (INSERT); Escape cancels. */
export function CreateDocForm({
  title,
  slug,
  error,
  creating,
  onSetShow,
  onSetTitle,
  onSetSlug,
  onCreate,
}: CreateDocFormProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSetShow(false);
    focusPaneById("items");
  };

  return (
    <form
      className="docs-create-form"
      aria-label="New document"
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        onCreate();
      }}
    >
      <label className="docs-create-label">
        <span>Title</span>
        <input
          ref={titleRef}
          className="docs-create-input"
          type="text"
          placeholder="My Context Notes"
          value={title}
          onChange={(e) => onSetTitle(e.target.value)}
          aria-label="New doc title"
        />
      </label>
      <label className="docs-create-label">
        <span>Slug</span>
        <input
          className="docs-create-input"
          type="text"
          placeholder="my-context-notes"
          value={slug}
          onChange={(e) => onSetSlug(e.target.value)}
          aria-label="New doc slug"
        />
      </label>
      <div className="docs-create-actions">
        <button
          type="submit"
          className="tbtn tbtn-primary"
          disabled={creating || !title.trim() || !slug.trim()}
        >
          {creating ? "creating…" : "create"}
        </button>
        <button type="button" className="tbtn" onClick={() => onSetShow(false)}>
          cancel
        </button>
        <span className="docs-create-hint">docs/context/</span>
      </div>
      {error && <div className="docs-create-error" role="alert">{error}</div>}
    </form>
  );
}
