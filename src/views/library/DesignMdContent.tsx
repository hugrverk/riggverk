import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DesignMdContent as DesignMdContentType, DesignMdPreviewContent } from "../../types";
import { Markdown } from "../../components/Markdown";
import { DesignMdGeneratedPreview } from "./DesignMdGeneratedPreview";
import { designMdDisplayTitle, designMdHasInspiredTitle } from "../../lib/designMdDisplay";

type PreviewMode = "generated-light" | "generated-dark" | "markdown" | "html" | "html-dark";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">`;

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
  const [previewMode, setPreviewMode] = useState<PreviewMode>("generated-light");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // When design entry changes, clear stale upstream HTML state and reset only unavailable optional modes.
  useEffect(() => {
    setPreviewHtml(null);
    setPreviewError(null);
    setPreviewLoading(false);
    if (activeContent) {
      if (previewMode === "html" && !activeContent.has_preview) {
        setPreviewMode("generated-light");
      } else if (previewMode === "html-dark" && !activeContent.has_preview_dark) {
        setPreviewMode("generated-light");
      }
    }
  }, [activeContent?.slug]);

  const loadHtmlPreview = useCallback(async (slug: string, variant: "light" | "dark") => {
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
    if (mode === "html" && activeContent) {
      loadHtmlPreview(activeContent.slug, "light");
    } else if (mode === "html-dark" && activeContent) {
      loadHtmlPreview(activeContent.slug, "dark");
    }
  }, [activeContent, loadHtmlPreview]);

  if (!activeContent) {
    return (
      <div className="lib-main-empty">
        <span className="log-prompt">$</span> Select a Design MD entry
      </div>
    );
  }

  const currentHash = activeContent.slug + activeContent.title;
  const displayTitle = designMdDisplayTitle(activeContent.slug);
  const inspired = designMdHasInspiredTitle(activeContent.title);

  return (
    <div className="design-md-content-panel">
      <div className="lib-editor-meta-strip">
        <div className="lib-editor-meta-left">
          <span className="lib-editor-meta-title">{displayTitle}</span>
          <span className="lib-editor-meta-path">
            {activeContent.slug} &middot; {activeContent.path}
            {inspired ? " · inspired upstream" : ""}
          </span>
        </div>
      </div>

      <div className="design-md-preview-tabs" role="tablist" aria-label="Design MD preview mode">
        <button
          className={`btn btn-sm ${previewMode === "generated-light" ? "btn-active" : ""}`}
          onClick={() => handleModeChange("generated-light")}
          role="tab"
          aria-selected={previewMode === "generated-light"}
        >
          preview
        </button>
        <button
          className={`btn btn-sm ${previewMode === "generated-dark" ? "btn-active" : ""}`}
          onClick={() => handleModeChange("generated-dark")}
          role="tab"
          aria-selected={previewMode === "generated-dark"}
        >
          dark
        </button>
        <button
          className={`btn btn-sm ${previewMode === "markdown" ? "btn-active" : ""}`}
          onClick={() => handleModeChange("markdown")}
          role="tab"
          aria-selected={previewMode === "markdown"}
        >
          markdown
        </button>
        {activeContent.has_preview && (
          <button
            className={`btn btn-sm ${previewMode === "html" ? "btn-active" : ""}`}
            onClick={() => handleModeChange("html")}
            role="tab"
            aria-selected={previewMode === "html"}
          >
            html
          </button>
        )}
        {activeContent.has_preview_dark && (
          <button
            className={`btn btn-sm ${previewMode === "html-dark" ? "btn-active" : ""}`}
            onClick={() => handleModeChange("html-dark")}
            role="tab"
            aria-selected={previewMode === "html-dark"}
          >
            html dark
          </button>
        )}
      </div>

      <div className="lib-editor-body">
        {previewMode === "generated-light" && (
          <DesignMdGeneratedPreview key={`${currentHash}-light`} activeContent={activeContent} variant="light" />
        )}

        {previewMode === "generated-dark" && (
          <DesignMdGeneratedPreview key={`${currentHash}-dark`} activeContent={activeContent} variant="dark" />
        )}

        {previewMode === "markdown" && (
          <div className="lib-preview-body">
            <Markdown content={activeContent.content} />
          </div>
        )}

        {(previewMode === "html" || previewMode === "html-dark") && (
          <div className="design-md-preview-frame-wrap">
            {previewLoading && (
              <div className="design-md-preview-loading">loading preview...</div>
            )}
            {previewError && (
              <div className="design-md-preview-unavailable">
                {previewMode === "html"
                  ? "No HTML preview available for this design"
                  : "No dark HTML preview available for this design"}
              </div>
            )}
            {previewHtml && !previewLoading && (
              <iframe
                className="design-md-preview-frame"
                srcDoc={previewHtml}
                sandbox=""
                title="Design MD HTML preview"
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
    </div>
  );
}
