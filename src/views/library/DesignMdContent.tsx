import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DesignMdContent as DesignMdContentType, DesignMdPreviewContent } from "../../types";
import { Markdown } from "../../components/Markdown";

type PreviewMode = "markdown" | "visual" | "visual-dark";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">`;

/** Always inject the strict CSP meta tag before any existing CSP or head content. */
function injectCsp(html: string): string {
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    return html.slice(0, headClose) + CSP_META + html.slice(headClose);
  }
  const htmlOpen = html.indexOf("<html");
  if (htmlOpen !== -1) {
    const headStart = html.indexOf("<head>", htmlOpen);
    if (headStart !== -1) {
      return html.slice(0, headStart + 6) + CSP_META + html.slice(headStart + 6);
    }
    const afterHtml = html.indexOf(">", htmlOpen) + 1;
    return html.slice(0, afterHtml) + "<head>" + CSP_META + "</head>" + html.slice(afterHtml);
  }
  return "<html><head>" + CSP_META + "</head><body>" + html + "</body></html>";
}

interface DesignMdContentProps {
  activeContent: DesignMdContentType | null;
}

export function DesignMdContent(props: DesignMdContentProps) {
  const { activeContent } = props;
  const [previewMode, setPreviewMode] = useState<PreviewMode>("markdown");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Clear stale preview state when design entry changes
  useEffect(() => {
    setPreviewHtml(null);
    setPreviewError(null);
    setPreviewLoading(false);
  }, [activeContent?.slug]);

  const loadPreview = useCallback(async (slug: string, variant: "light" | "dark") => {
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewHtml(null);
    try {
      const result = await invoke<DesignMdPreviewContent>("read_design_md_preview", { slug, variant });
      setPreviewHtml(injectCsp(result.html));
    } catch (e) {
      setPreviewError(String(e));
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const handleModeChange = useCallback((mode: PreviewMode) => {
    setPreviewMode(mode);
    if (mode === "visual" && activeContent) {
      loadPreview(activeContent.slug, "light");
    } else if (mode === "visual-dark" && activeContent) {
      loadPreview(activeContent.slug, "dark");
    }
  }, [activeContent, loadPreview]);

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

      <div className="design-md-preview-tabs" role="tablist" aria-label="Design MD preview mode">
        <button
          className={`btn btn-sm ${previewMode === "markdown" ? "btn-active" : ""}`}
          onClick={() => handleModeChange("markdown")}
          role="tab"
          aria-selected={previewMode === "markdown"}
        >
          markdown
        </button>
        <button
          className={`btn btn-sm ${previewMode === "visual" ? "btn-active" : ""}`}
          onClick={() => handleModeChange("visual")}
          role="tab"
          aria-selected={previewMode === "visual"}
        >
          visual
        </button>
        <button
          className={`btn btn-sm ${previewMode === "visual-dark" ? "btn-active" : ""}`}
          onClick={() => handleModeChange("visual-dark")}
          role="tab"
          aria-selected={previewMode === "visual-dark"}
        >
          visual dark
        </button>
      </div>

      <div className="lib-editor-body">
        {previewMode === "markdown" && (
          <div className="lib-preview-body">
            <Markdown content={activeContent.content} />
          </div>
        )}

        {(previewMode === "visual" || previewMode === "visual-dark") && (
          <div className="design-md-preview-frame-wrap">
            {previewLoading && (
              <div className="design-md-preview-loading">loading preview...</div>
            )}
            {previewError && (
              <div className="design-md-preview-error">
                <span>{previewError}</span>
              </div>
            )}
            {previewHtml && !previewLoading && (
              <iframe
                className="design-md-preview-frame"
                srcDoc={previewHtml}
                sandbox=""
                title="Design MD visual preview"
              />
            )}
            <div className="design-md-preview-warning">
              Sandboxed preview; external assets and scripts are blocked
            </div>
          </div>
        )}
      </div>

      <div className="design-md-lib-hint">
        Install from Workspace
      </div>
    </>
  );
}
