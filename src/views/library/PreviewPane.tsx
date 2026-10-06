import { useDeferredValue, useMemo } from "react";
import { CopyableBlock } from "../../components/CopyableBlock";
import { Kv } from "../../ui/Kv";
import { Pane } from "../../ui/Pane";
import { DocContent } from "./DocContent";
import type { LibraryEntry } from "./entry";

function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

/**
 * Pane [3]: the working copy rendered, so edits show up before they are saved. The text is deferred, which
 * keeps typing responsive while a long document is re-parsed.
 */
export function PreviewPane({ entry }: { entry: LibraryEntry | null }) {
  const draft = useDeferredValue(entry?.draft ?? "");
  const isJson = entry?.preview === "json";
  const formatted = useMemo(() => (isJson ? formatJson(draft) : ""), [isJson, draft]);

  return (
    <Pane id="preview" index={3} label="Preview" title="preview" meta={isJson ? "· json" : "· rendered"} scrollable>
      {!entry ? (
        <p className="c-dim" role="status">Nothing to preview</p>
      ) : (
        <>
          {entry.meta.length > 0 && (
            <div className="lib-meta" role="region" aria-label={entry.metaTitle ?? "Metadata"}>
              {entry.metaTitle && <p className="group">{entry.metaTitle}</p>}
              <Kv items={entry.meta} />
            </div>
          )}
          {isJson ? (
            <CopyableBlock text={formatted} className="copyable-block-terminal copyable-block-fill">
              <pre className="configs-code">{formatted}</pre>
            </CopyableBlock>
          ) : (
            <DocContent content={draft} />
          )}
        </>
      )}
    </Pane>
  );
}
