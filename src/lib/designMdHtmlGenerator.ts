import type { DesignMdSpecimen, DesignMdBoard, DesignMdBoardComponentGroup } from "./designMdSpecimenBuilder";

const CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:;">';

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isSafeColor(val: string): string | null {
  const t = val.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return t;
  if (/^rgba?\s*\([^)]+\)$/.test(t)) return t;
  if (/^hsl/.test(t)) return t;
  return null;
}

/** Legacy generic page — delegates to board for backward compat. */
export function generateSpecimenHtml(spec: DesignMdSpecimen): string {
  return generateBoardHtml({
    slug: spec.slug,
    title: spec.title,
    description: spec.description,
    colorGroups: [{ prefix: "palette", tokens: [
      { key: "primary", rawValue: spec.primaryColor, resolvedValue: spec.primaryColor },
      { key: "surface", rawValue: spec.surfaceColor, resolvedValue: spec.surfaceColor },
      { key: "canvas", rawValue: spec.canvasColor, resolvedValue: spec.canvasColor },
      { key: "text", rawValue: spec.textColor, resolvedValue: spec.textColor },
      { key: "muted", rawValue: spec.mutedColor, resolvedValue: spec.mutedColor },
      { key: "border", rawValue: spec.borderColor, resolvedValue: spec.borderColor },
    ]}],
    typographyTokens: [],
    radiusTokens: [
      { key: "sm", rawValue: spec.radiusSm, resolvedValue: spec.radiusSm },
      { key: "md", rawValue: spec.radiusMd, resolvedValue: spec.radiusMd },
      { key: "lg", rawValue: spec.radiusLg, resolvedValue: spec.radiusLg },
      { key: "pill", rawValue: spec.radiusPill, resolvedValue: spec.radiusPill },
    ],
    spacingTokens: [
      { key: "sm", rawValue: spec.spaceSm, resolvedValue: spec.spaceSm },
      { key: "md", rawValue: spec.spaceMd, resolvedValue: spec.spaceMd },
      { key: "lg", rawValue: spec.spaceLg, resolvedValue: spec.spaceLg },
    ],
    componentGroups: [],
    overview: spec.overview,
    layout: null,
  });
}

function pickToken(tokens: { key: string; resolvedValue: string }[], matches: string[], fallback: string): string {
  for (const m of matches) {
    const t = tokens.find(tk => tk.key.includes(m));
    if (t) return t.resolvedValue;
  }
  return fallback;
}

function pickColor(tokens: { key: string; resolvedValue: string }[], matches: string[], fallback: string): string {
  for (const m of matches) {
    const t = tokens.find(tk => tk.key.includes(m));
    if (t) {
      const safe = isSafeColor(t.resolvedValue);
      if (safe) return safe;
    }
  }
  return fallback;
}

export function generateBoardHtml(board: DesignMdBoard): string {
  const allColors = board.colorGroups.flatMap(g => g.tokens);
  const canvas = pickColor(allColors, ["background", "canvas", "white", "page"], "#ffffff");
  const surface = pickColor(allColors, ["surface", "card", "elevated"], "#f5f5f5");
  const text = pickColor(allColors, ["text", "ink", "black", "foreground"], "#111111");
  const primary = pickColor(allColors, ["primary", "brand", "accent", "blue"], "#0066cc");
  const muted = pickColor(allColors, ["muted", "secondary", "gray", "grey"], "#888888");
  const border = pickColor(allColors, ["border", "hairline", "divider", "stroke", "line"], "#e0e0e0");
  const accent = pickColor(allColors, ["on-primary", "onPrimary", "white", "light"], "#ffffff");
  const onPrimary = accent;

  const spaceSm = pickToken(board.spacingTokens, ["sm", "xs", "small"], "8px");
  const spaceMd = pickToken(board.spacingTokens, ["md", "medium", "default"], "16px");
  const spaceLg = pickToken(board.spacingTokens, ["lg", "xl", "large"], "32px");
  const radiusSm = pickToken(board.radiusTokens, ["sm", "small", "xs"], "4px");
  const radiusMd = pickToken(board.radiusTokens, ["md", "medium", "default", "base"], "8px");

  const bodyFont = board.typographyTokens[0]?.fontFamily || '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  const headingToken = board.typographyTokens.find(t =>
    t.key.includes("display") || t.key.includes("h1") || t.key.includes("heading")
  ) || board.typographyTokens[0];
  const bodyToken = board.typographyTokens.find(t =>
    t.key.includes("body") || t.key.includes("text") || t.key.includes("base") || t.key.includes("copy")
  ) || board.typographyTokens[1] || board.typographyTokens[0];
  const headingSize = headingToken?.fontSize || "28px";
  const headingWeight = headingToken?.fontWeight || "700";
  const bodySize = bodyToken?.fontSize || "16px";
  const captionSize = board.typographyTokens.find(t =>
    t.key.includes("caption") || t.key.includes("small") || t.key.includes("label")
  )?.fontSize || "12px";

  const css = [
    "*{box-sizing:border-box;margin:0;padding:0}",
    "body{font-family:" + esc(bodyFont) + ";font-size:" + esc(bodySize) + ";color:" + esc(text) + ";background:" + esc(canvas) + ";line-height:1.6;-webkit-font-smoothing:antialiased}",
    ".b-header{text-align:center;padding:" + esc(spaceLg) + " " + esc(spaceMd) + " " + esc(spaceMd) + "}",
    ".b-header h1{font-size:" + esc(headingSize) + ";font-weight:" + esc(headingWeight) + ";margin-bottom:" + esc(spaceSm) + "}",
    ".b-header p{color:" + esc(muted) + ";max-width:560px;margin:0 auto;font-size:" + esc(bodySize) + "}",
    ".b-meta{text-align:right;padding:4px " + esc(spaceMd) + ";font-size:9px;color:" + esc(muted) + ";opacity:.35}",
    ".b-section{padding:" + esc(spaceLg) + " " + esc(spaceMd) + "}",
    ".b-section-label{font-size:10px;color:" + esc(muted) + ";text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:" + esc(spaceSm) + ";border-bottom:1px solid " + esc(border) + ";padding-bottom:4px}",
    ".b-swatch-grid{display:flex;flex-wrap:wrap;gap:8px}",
    ".b-swatch{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid " + esc(border) + ";border-radius:" + esc(radiusSm) + ";background:" + esc(surface) + "}",
    ".b-swatch-chip{width:28px;height:28px;border-radius:4px;border:1px solid " + esc(border) + ";flex-shrink:0}",
    ".b-swatch-info{display:flex;flex-direction:column;min-width:0}",
    ".b-swatch-name{font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".b-swatch-value{font-size:10px;color:" + esc(muted) + ";font-family:monospace}",
    ".b-typo-grid{display:flex;flex-direction:column;gap:" + esc(spaceMd) + "}",
    ".b-typo-row{display:flex;align-items:baseline;gap:" + esc(spaceMd) + ";padding:" + esc(spaceSm) + " 0;border-bottom:1px solid " + esc(border) + "}",
    ".b-typo-meta{min-width:100px;font-size:11px;color:" + esc(muted) + "}",
    ".b-typo-sample{flex:1}",
    ".b-comp-grid{display:flex;flex-wrap:wrap;gap:" + esc(spaceMd) + ";align-items:flex-start}",
    ".b-comp-item{display:flex;flex-direction:column;gap:4px;max-width:340px}",
    ".b-comp-label{font-size:10px;color:" + esc(muted) + ";text-transform:uppercase;letter-spacing:.04em}",
    ".b-radius-bar{display:flex;gap:" + esc(spaceSm) + ";flex-wrap:wrap}",
    ".b-radius-chip{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border:1px solid " + esc(border) + ";font-size:9px;color:" + esc(muted) + ";background:" + esc(surface) + "}",
    ".b-notes{font-size:" + esc(captionSize) + ";color:" + esc(muted) + ";line-height:1.6;max-width:600px}",
    ".b-notes p{margin-bottom:" + esc(spaceSm) + "}",
    ".b-footer{text-align:center;padding:" + esc(spaceMd) + ";font-size:10px;color:" + esc(muted) + ";border-top:1px solid " + esc(border) + ";opacity:.5}",
    ".b-hero-actions{display:flex;gap:" + esc(spaceSm) + ";justify-content:center;margin-top:" + esc(spaceMd) + "}",
    ".b-btn-primary{padding:10px " + esc(spaceLg) + ";font-size:" + esc(bodySize) + ";background:" + esc(primary) + ";color:" + esc(onPrimary) + ";border:none;border-radius:" + esc(radiusMd) + ";font-weight:600;cursor:default}",
    ".b-btn-secondary{padding:10px " + esc(spaceLg) + ";font-size:" + esc(bodySize) + ";background:transparent;color:" + esc(primary) + ";border:1px solid " + esc(primary) + ";border-radius:" + esc(radiusMd) + ";font-weight:600;cursor:default}",
    "@media(max-width:500px){.b-comp-grid{flex-direction:column}.b-typo-meta{min-width:70px}}",
  ].join("\n");

  // color swatches
  const colorsHtml = allColors.slice(0, 20).map(t => {
    const safe = isSafeColor(t.resolvedValue);
    const bg = safe ? esc(t.resolvedValue) : "#ccc";
    const label = esc(t.key);
    const val = t.rawValue !== t.resolvedValue
      ? esc(t.rawValue + " \u2192 " + t.resolvedValue)
      : esc(t.resolvedValue);
    return '<div class="b-swatch">' +
      '<div class="b-swatch-chip" style="background:' + bg + '"></div>' +
      '<div class="b-swatch-info">' +
      '<span class="b-swatch-name">' + label + '</span>' +
      '<span class="b-swatch-value">' + val + '</span>' +
      '</div></div>';
  }).join("");

  // typography
  const typoHtml = board.typographyTokens.slice(0, 10).map(t => {
    const styles = [
      t.fontSize ? "font-size:" + esc(t.fontSize) : "",
      t.fontWeight ? "font-weight:" + esc(t.fontWeight) : "",
      t.lineHeight ? "line-height:" + esc(t.lineHeight) : "",
      t.fontFamily ? "font-family:" + esc(t.fontFamily) : "",
    ].filter(Boolean).join(";");
    const meta = [
      esc(t.key),
      t.fontSize ? '<br><span style="font-size:9px">' + esc(t.fontSize) + (t.fontWeight ? " / " + esc(t.fontWeight) : "") + "</span>" : "",
    ].join("");
    return '<div class="b-typo-row">' +
      '<div class="b-typo-meta">' + meta + '</div>' +
      '<span class="b-typo-sample" style="' + styles + '">The quick brown fox jumps over the lazy dog.</span>' +
      '</div>';
  }).join("");

  // component samples
  function compSampleHtml(g: DesignMdBoardComponentGroup): string {
    const bg = isSafeColor(g.backgroundColor || "") || primary;
    const txt = isSafeColor(g.textColor || "") || onPrimary;
    const rad = g.rounded || radiusMd;
    const pad = g.padding || spaceMd;
    const name = esc(g.name);
    switch (g.kind) {
      case "button":
        return '<button style="background:' + bg + ';color:' + txt + ';border-radius:' + esc(rad) +
          ';padding:10px ' + esc(pad) + ';border:none;font-weight:600;cursor:default;font-size:' +
          esc(bodySize) + '">' + name + '</button>';
      case "card":
        return '<div style="background:' + (isSafeColor(g.backgroundColor || "") || surface) +
          ';border:1px solid ' + esc(border) + ';border-radius:' + esc(rad) + ';padding:' + esc(pad) + '">' +
          '<div style="font-weight:600;margin-bottom:8px">' + name + '</div>' +
          '<div style="font-size:' + esc(captionSize) + ';color:' + esc(muted) + '">Card component using ' + name + ' tokens.</div>' +
          '</div>';
      case "tile":
        return '<div style="background:' + (isSafeColor(g.backgroundColor || "") || surface) +
          ';border-radius:' + esc(rad) + ';padding:' + esc(pad) + '">' +
          '<div style="font-size:' + esc(bodySize) + ';font-weight:500">' + name + '</div>' +
          '<div style="font-size:' + esc(captionSize) + ';color:' + esc(muted) + ';margin-top:4px">Component sample</div>' +
          '</div>';
      case "input":
        return '<input type="text" placeholder="' + name + '" readonly style="padding:8px ' +
          esc(spaceSm) + ';border:1px solid ' + esc(border) + ';border-radius:' + esc(rad) +
          ';font-size:' + esc(captionSize) + ';background:' + esc(canvas) + ';color:' + esc(text) + ';outline:none;min-width:160px">';
      case "chip":
        return '<span style="padding:4px ' + esc(spaceSm) + ';font-size:11px;background:' +
          (isSafeColor(g.backgroundColor || "") || surface) + ';color:' +
          (txt !== accent ? txt : muted) + ';border:1px solid ' + esc(border) + ';border-radius:9999px">' + name + '</span>';
      case "nav":
        return '<div style="display:flex;align-items:center;gap:' + esc(spaceMd) + ';padding:' +
          esc(spaceSm) + ' ' + esc(spaceMd) + ';background:' +
          (isSafeColor(g.backgroundColor || "") || surface) + ';border-radius:' + esc(rad) + '">' +
          '<span style="font-weight:600">' + name + '</span>' +
          '<span style="color:' + esc(muted) + ';font-size:' + esc(captionSize) + '">Link</span>' +
          '<span style="color:' + esc(muted) + ';font-size:' + esc(captionSize) + '">Link</span>' +
          '</div>';
      case "link":
        return '<span style="color:' + esc(primary) + ';text-decoration:underline;cursor:default;font-size:' +
          esc(bodySize) + '">' + name + ' link</span>';
      case "quote":
        return '<blockquote style="border-left:3px solid ' + esc(primary) + ';padding:' +
          esc(spaceSm) + ' ' + esc(spaceMd) + ';font-size:' + esc(bodySize) + ';color:' +
          esc(muted) + ';background:' + esc(surface) + ';border-radius:' + esc(rad) + ';margin:0">' +
          '&ldquo;Quote block using ' + name + ' tokens.&rdquo;</blockquote>';
      case "footer":
        return '<div style="text-align:center;padding:' + esc(spaceMd) + ';font-size:10px;color:' +
          esc(muted) + ';border-top:1px solid ' + esc(border) + '">' + name + ' &mdash; footer</div>';
      default: {
        const rawKeys = Object.entries(g.raw).slice(0, 4).map(([k, v]) =>
          '<div style="font-size:10px;color:' + esc(muted) + '">' + esc(k) + ': ' + esc(v) + '</div>'
        ).join("");
        return '<div style="background:' + (isSafeColor(g.backgroundColor || "") || surface) +
          ';border:1px solid ' + esc(border) + ';border-radius:' + esc(rad) + ';padding:' + esc(pad) + '">' +
          '<div style="font-weight:500;margin-bottom:4px">' + name + '</div>' + rawKeys + '</div>';
      }
    }
  }

  const compHtml = board.componentGroups.length > 0
    ? board.componentGroups.map(g =>
        '<div class="b-comp-item"><span class="b-comp-label">' + esc(g.name) + '</span>' + compSampleHtml(g) + '</div>'
      ).join("")
    : "";

  // radius
  const radiusHtml = board.radiusTokens.slice(0, 8).map(t =>
    '<div class="b-radius-chip" style="border-radius:' + esc(t.resolvedValue) + '"><span>' + esc(t.key) + '</span></div>'
  ).join("");

  // notes
  const notesParts: string[] = [];
  if (board.overview) notesParts.push("<p><strong>Overview</strong> " + esc(board.overview) + "</p>");
  if (board.layout) notesParts.push("<p><strong>Layout</strong> " + esc(board.layout) + "</p>");
  if (board.spacingTokens.length > 0) {
    const spaceSummary = board.spacingTokens.map(t => esc(t.key) + ": " + esc(t.resolvedValue)).join(" \u00b7 ");
    notesParts.push("<p><strong>Spacing</strong> " + spaceSummary + "</p>");
  }

  const sections: string[] = [];

  // Header
  sections.push(
    '<div class="b-header">' +
    '<h1>' + esc(board.title) + '</h1>' +
    (board.description ? '<p>' + esc(board.description) + '</p>' : '') +
    '<div class="b-hero-actions">' +
    '<button class="b-btn-primary">Primary</button>' +
    '<button class="b-btn-secondary">Secondary</button>' +
    '</div>' +
    '</div>'
  );
  sections.push('<div class="b-meta">' + esc(board.slug) + ' \u00b7 Generated from DESIGN.md</div>');

  // Colors
  if (colorsHtml) {
    sections.push(
      '<section class="b-section">' +
      '<div class="b-section-label">Colors</div>' +
      '<div class="b-swatch-grid">' + colorsHtml + '</div>' +
      '</section>'
    );
  }

  // Typography
  if (typoHtml) {
    sections.push(
      '<section class="b-section">' +
      '<div class="b-section-label">Typography</div>' +
      '<div class="b-typo-grid">' + typoHtml + '</div>' +
      '</section>'
    );
  }

  // Components
  if (compHtml) {
    sections.push(
      '<section class="b-section">' +
      '<div class="b-section-label">Components</div>' +
      '<div class="b-comp-grid">' + compHtml + '</div>' +
      '</section>'
    );
  }

  // Radius + Spacing
  if (board.radiusTokens.length > 0 || board.spacingTokens.length > 0) {
    let body = '';
    if (board.radiusTokens.length > 0) {
      body += '<div><span style="font-size:10px;color:' + esc(muted) + '">Radius</span></div>' +
        '<div class="b-radius-bar" style="margin-top:4px">' + radiusHtml + '</div>';
    }
    if (board.spacingTokens.length > 0) {
      const spaceVals = board.spacingTokens.map(t => esc(t.key) + ": " + esc(t.resolvedValue)).join(" \u00b7 ");
      body += '<div style="margin-top:' + esc(spaceSm) + '"><span style="font-size:10px;color:' + esc(muted) + '">Spacing</span></div>' +
        '<div style="font-size:11px;color:' + esc(muted) + '">' + spaceVals + '</div>';
    }
    sections.push('<section class="b-section">' + body + '</section>');
  }

  // Notes
  if (notesParts.length > 0) {
    sections.push(
      '<section class="b-section">' +
      '<div class="b-section-label">Notes</div>' +
      '<div class="b-notes">' + notesParts.join("") + '</div>' +
      '</section>'
    );
  }

  // Footer
  sections.push(
    '<div class="b-footer">' + esc(board.slug) + ' \u00b7 Generated from DESIGN.md</div>'
  );

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    CSP + '\n<style>' + css + '</style>\n</head>\n<body>\n' +
    sections.join("\n") + '\n</body>\n</html>';
}
