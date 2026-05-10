import { useMemo } from "react";
import type { DesignMdContent } from "../../types";
import {
  parseDesignMdForPreview,
  safeColorStyle,
  safeTypoStyle,
  safeButtonStyle,
  safeCardStyle,
  parseFlatFrontmatter,
} from "../../lib/designMdPreviewParser";
import type { DesignMdPreviewModel } from "../../lib/designMdPreviewParser";

interface Props {
  activeContent: DesignMdContent;
}

export function DesignMdGeneratedPreview({ activeContent }: Props) {
  const model: DesignMdPreviewModel = useMemo(
    () =>
      parseDesignMdForPreview(
        activeContent.slug,
        activeContent.title,
        activeContent.description,
        activeContent.content,
      ),
    [activeContent],
  );

  const fm = useMemo(() => parseFlatFrontmatter(activeContent.content), [activeContent.content]);

  const primaryBtnStyle = useMemo(() => safeButtonStyle(fm), [fm]);
  const secondaryBtnStyle = useMemo(() => {
    const style = safeButtonStyle(fm);
    if (style.backgroundColor) {
      style.backgroundColor = "transparent";
      if (style.color) style.borderColor = style.color;
    }
    return style;
  }, [fm]);
  const cardStyle = useMemo(() => safeCardStyle(fm), [fm]);

  const bodyFont = fm.get("typography.font-family");
  const bodySize = fm.get("typography.font-size-base");
  const bodyWeight = fm.get("typography.font-weight-normal");
  const bodyLine = fm.get("typography.line-height");
  const bodyStyle = useMemo(
    () => safeTypoStyle(bodySize, bodyWeight, bodyLine, bodyFont),
    [bodySize, bodyWeight, bodyLine, bodyFont],
  );

  const headingFont = fm.get("typography.heading-font-family") || bodyFont;
  const headingSize = fm.get("typography.h1-font-size") || fm.get("typography.heading-font-size");
  const headingWeight = fm.get("typography.h1-font-weight") || fm.get("typography.heading-font-weight");
  const headingStyle = useMemo(
    () => safeTypoStyle(headingSize, headingWeight, bodyLine, headingFont),
    [headingSize, headingWeight, bodyLine, headingFont],
  );

  return (
      <div className="design-md-generated">
        <div className="design-md-generated-note">Generated from DESIGN.md</div>
        {/* Header */}
        <div className="design-md-generated-header">
        <h2 className="design-md-gen-title">{model.title || model.slug}</h2>
        {model.description && (
          <p className="design-md-gen-desc">{model.description}</p>
        )}
      </div>

      {/* Overview */}
      {(model.overviewText || model.layoutText) && (
        <div className="design-md-generated-section">
          <div className="design-md-gen-section-label">Overview</div>
          {model.overviewText && (
            <p className="design-md-gen-text">{model.overviewText}</p>
          )}
          {model.layoutText && (
            <p className="design-md-gen-text">
              <span className="design-md-gen-text-label">Layout: </span>
              {model.layoutText}
            </p>
          )}
        </div>
      )}

      {/* Color palette */}
      {model.colors.length > 0 && (
        <div className="design-md-generated-section">
          <div className="design-md-gen-section-label">Colors</div>
          <div className="design-md-swatch-grid">
            {model.colors.map((c) => {
              const style = safeColorStyle(c.value);
              return (
                <div key={c.key} className="design-md-swatch">
                  <div
                    className="design-md-swatch-chip"
                    style={style ?? undefined}
                  />
                  <div className="design-md-swatch-info">
                    <span className="design-md-swatch-name">{c.key}</span>
                    <span className="design-md-swatch-value">{c.value}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Typography */}
      {model.typography.length > 0 && (
        <div className="design-md-generated-section">
          <div className="design-md-gen-section-label">Typography</div>
          <div className="design-md-type-list">
            {model.typography.map((t) => (
              <div key={t.key} className="design-md-type-row">
                <span className="design-md-type-name">{t.key}</span>
                <span className="design-md-type-value">{t.value}</span>
              </div>
            ))}
          </div>
          <div className="design-md-type-sample-label">Sample</div>
          <div className="design-md-type-sample" style={bodyStyle}>
            <p style={headingStyle}>Heading Sample</p>
            <p>The quick brown fox jumps over the lazy dog. 1234567890.</p>
          </div>
        </div>
      )}

      {/* Component samples */}
      {model.components.length > 0 && (
        <div className="design-md-generated-section">
          <div className="design-md-gen-section-label">Components</div>
          <div className="design-md-component-stage">
            <button className="design-md-sample-button" style={primaryBtnStyle}>
              Primary Button
            </button>
            <button className="design-md-sample-button" style={secondaryBtnStyle}>
              Secondary Button
            </button>
          </div>
          {Object.keys(cardStyle).length > 0 && (
            <div className="design-md-sample-card" style={cardStyle}>
              <div className="design-md-sample-card-title">Card Title</div>
              <div className="design-md-sample-card-body">
                This is a sample card demonstrating the card background, border-radius, and padding from the design tokens.
              </div>
            </div>
          )}
          <div className="design-md-component-tokens">
            {model.components.map((c) => (
              <div key={c.key} className="design-md-component-token">
                <span className="design-md-component-token-name">{c.key}</span>
                <span className="design-md-component-token-value">{c.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Guardrails */}
      {(model.guardrailDos.length > 0 || model.guardrailDonts.length > 0) && (
        <div className="design-md-generated-section">
          <div className="design-md-gen-section-label">Guardrails</div>
          {model.guardrailDos.length > 0 && (
            <>
              <span className="design-md-gen-do-label">Do</span>
              <ul className="design-md-gen-list design-md-gen-list-do">
                {model.guardrailDos.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {model.guardrailDonts.length > 0 && (
            <>
              <span className="design-md-gen-dont-label">Don't</span>
              <ul className="design-md-gen-list design-md-gen-list-dont">
                {model.guardrailDonts.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {model.colors.length === 0 && model.typography.length === 0 && model.components.length === 0 && (
        <div className="design-md-gen-empty">
          No structured tokens found in DESIGN.md. Switch to markdown preview to see raw content.
        </div>
      )}
    </div>
  );
}
