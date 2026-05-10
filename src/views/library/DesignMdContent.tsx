import type { DesignMdContent as DesignMdContentType } from "../../types";
import { Markdown } from "../../components/Markdown";

interface DesignMdContentProps {
  activeContent: DesignMdContentType | null;
}

export function DesignMdContent(props: DesignMdContentProps) {
  const { activeContent } = props;

  if (!activeContent) {
    return (
      <div className="lib-main-empty">
        <span className="log-prompt">$</span> Select a Design MD entry
      </div>
    );
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

      <div className="lib-editor-body">
        <div className="lib-preview-body">
          <Markdown content={activeContent.content} />
        </div>
      </div>

      <div className="design-md-lib-hint">
        Install from Workspace
      </div>
    </>
  );
}
