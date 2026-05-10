import type { DesignMdSpecimen } from "./designMdSpecimenBuilder";

/** Generate a sandboxed HTML specimen document from a design specimen. */
export function generateSpecimenHtml(spec: DesignMdSpecimen): string {
  const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">`;

  const css = `
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:${esc(spec.fontFamily)};
      font-size:${esc(spec.bodySize)};
      color:${esc(spec.textColor)};
      background:${esc(spec.canvasColor)};
      line-height:1.6;
      -webkit-font-smoothing:antialiased
    }
    .nav{
      display:flex;align-items:center;justify-content:space-between;
      padding:${esc(spec.spaceMd)} ${esc(spec.spaceLg)};
      border-bottom:1px solid ${esc(spec.borderColor)};
      background:${esc(spec.surfaceColor)}
    }
    .nav-brand{font-weight:${esc(spec.headingWeight)};font-size:18px;color:${esc(spec.textColor)}}
    .nav-links{display:flex;gap:${esc(spec.spaceMd)};font-size:${esc(spec.captionSize)};color:${esc(spec.mutedColor)}}
    .nav-cta{
      padding:6px ${esc(spec.spaceMd)};font-size:${esc(spec.captionSize)};
      background:${esc(spec.btnBg)};color:${esc(spec.btnColor)};
      border:none;border-radius:${esc(spec.btnRadius)};cursor:default
    }
    .hero{
      text-align:center;padding:${esc(spec.spaceLg)} ${esc(spec.spaceMd)} ${esc(spec.spaceMd)};
      max-width:640px;margin:0 auto
    }
    .hero h1{font-size:${esc(spec.headingSize)};font-weight:${esc(spec.headingWeight)};margin-bottom:${esc(spec.spaceSm)}}
    .hero p{color:${esc(spec.mutedColor)};font-size:${esc(spec.bodySize)};margin-bottom:${esc(spec.spaceMd)}}
    .hero-actions{display:flex;gap:${esc(spec.spaceSm)};justify-content:center}
    .btn-primary{
      padding:10px ${esc(spec.spaceLg)};font-size:${esc(spec.captionSize)};
      background:${esc(spec.btnBg)};color:${esc(spec.btnColor)};
      border:none;border-radius:${esc(spec.btnRadius)};cursor:default;font-weight:600
    }
    .btn-secondary{
      padding:10px ${esc(spec.spaceLg)};font-size:${esc(spec.captionSize)};
      background:transparent;color:${esc(spec.btnBg)};
      border:1px solid ${esc(spec.btnBg)};border-radius:${esc(spec.btnRadius)};cursor:default;font-weight:600
    }
    .btn-ghost{
      padding:8px ${esc(spec.spaceMd)};font-size:${esc(spec.captionSize)};
      background:transparent;color:${esc(spec.mutedColor)};
      border:none;cursor:default
    }
    .strip{
      display:flex;align-items:center;gap:${esc(spec.spaceSm)};flex-wrap:wrap;
      padding:${esc(spec.spaceMd)} ${esc(spec.spaceLg)};
      border-top:1px solid ${esc(spec.borderColor)};
      border-bottom:1px solid ${esc(spec.borderColor)};
      background:${esc(spec.surfaceColor)}
    }
    .chip{
      padding:4px ${esc(spec.spaceSm)};font-size:11px;
      background:${esc(spec.surfaceColor)};color:${esc(spec.mutedColor)};
      border:1px solid ${esc(spec.borderColor)};border-radius:${esc(spec.radiusPill)}
    }
    .input{
      padding:8px ${esc(spec.spaceSm)};font-size:${esc(spec.captionSize)};
      border:1px solid ${esc(spec.borderColor)};border-radius:${esc(spec.radiusSm)};
      background:${esc(spec.canvasColor)};color:${esc(spec.textColor)};
      outline:none;min-width:160px
    }
    .section{padding:${esc(spec.spaceLg)} ${esc(spec.spaceLg)}}
    .section-label{
      font-size:${esc(spec.captionSize)};color:${esc(spec.mutedColor)};
      text-transform:uppercase;letter-spacing:.05em;margin-bottom:${esc(spec.spaceSm)}
    }
    .card-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:${esc(spec.spaceMd)}}
    .card{
      background:${esc(spec.surfaceColor)};border:1px solid ${esc(spec.borderColor)};
      border-radius:${esc(spec.radiusLg)};padding:${esc(spec.spaceMd)}
    }
    .card-title{font-weight:600;font-size:${esc(spec.bodySize)};margin-bottom:${esc(spec.spaceSm)}}
    .card-text{font-size:${esc(spec.captionSize)};color:${esc(spec.mutedColor)};line-height:1.5;margin-bottom:${esc(spec.spaceSm)}}
    .card-action{font-size:${esc(spec.captionSize)};color:${esc(spec.btnBg)};font-weight:600}
    .typo-panel{display:flex;flex-direction:column;gap:${esc(spec.spaceMd)}}
    .typo-row{display:flex;align-items:baseline;gap:${esc(spec.spaceMd)}}
    .typo-sample{flex:1;font-family:${esc(spec.fontFamily)}}
    .typo-label{font-size:11px;color:${esc(spec.mutedColor)};min-width:60px}
    .swatch-grid{display:flex;flex-wrap:wrap;gap:${esc(spec.spaceSm)}}
    .swatch{display:flex;align-items:center;gap:${esc(spec.spaceSm)};padding:${esc(spec.spaceSm)} ${esc(spec.spaceSm)};
      border:1px solid ${esc(spec.borderColor)};border-radius:${esc(spec.radiusSm)};background:${esc(spec.surfaceColor)}
    }
    .swatch-chip{width:24px;height:24px;border-radius:${esc(spec.radiusSm)};border:1px solid ${esc(spec.borderColor)}}
    .swatch-label{font-size:11px}
    .swatch-value{font-size:10px;color:${esc(spec.mutedColor)};font-family:monospace}
    .split{display:grid;grid-template-columns:1fr 1fr;gap:${esc(spec.spaceLg)};
      padding:${esc(spec.spaceLg)};border-top:1px solid ${esc(spec.borderColor)}
    }
    .split-block h3{font-size:${esc(spec.bodySize)};font-weight:600;margin-bottom:${esc(spec.spaceSm)}}
    .split-block p{font-size:${esc(spec.captionSize)};color:${esc(spec.mutedColor)}}
    .footer{
      text-align:center;padding:${esc(spec.spaceMd)};font-size:10px;
      color:${esc(spec.mutedColor)};border-top:1px solid ${esc(spec.borderColor)};
      opacity:.5
    }
    @media(max-width:500px){.card-grid{grid-template-columns:1fr}.split{grid-template-columns:1fr}}
  `;

  const palette = [
    { name: "primary", hex: spec.primaryColor },
    { name: "surface", hex: spec.surfaceColor },
    { name: "canvas", hex: spec.canvasColor },
    { name: "text", hex: spec.textColor },
    { name: "muted", hex: spec.mutedColor },
    { name: "border", hex: spec.borderColor },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${CSP}
<style>${css}</style>
</head>
<body>

<nav class="nav">
  <span class="nav-brand">${esc(spec.title)}</span>
  <div class="nav-links">
    <span>Features</span><span>Docs</span><span>Pricing</span>
  </div>
  <span class="nav-cta">Get started</span>
</nav>

<section class="hero">
  <h1>${esc(spec.title)} Design System</h1>
  ${spec.overview ? `<p>${esc(spec.overview)}</p>` : `<p>A design system built with ${esc(spec.title)} tokens.</p>`}
  <div class="hero-actions">
    <button class="btn-primary">Primary CTA</button>
    <button class="btn-secondary">Secondary CTA</button>
  </div>
</section>

<div class="strip">
  <button class="btn-primary">Button</button>
  <button class="btn-secondary">Secondary</button>
  <button class="btn-ghost">Ghost</button>
  <input class="input" type="text" placeholder="Search..." readonly>
  <span class="chip">chip</span>
  <span class="chip">badge</span>
</div>

<section class="section">
  <div class="section-label">Cards</div>
  <div class="card-grid">
    <div class="card">
      <div class="card-title">Feature One</div>
      <div class="card-text">A description of the first feature using the design tokens.</div>
      <span class="card-action">Learn more →</span>
    </div>
    <div class="card">
      <div class="card-title">Feature Two</div>
      <div class="card-text">A description of the second feature using the design tokens.</div>
      <span class="card-action">Learn more →</span>
    </div>
    <div class="card">
      <div class="card-title">Feature Three</div>
      <div class="card-text">A description of the third feature using the design tokens.</div>
      <span class="card-action">Learn more →</span>
    </div>
  </div>
</section>

<section class="section">
  <div class="section-label">Typography</div>
  <div class="typo-panel">
    <div class="typo-row">
      <span class="typo-label">${esc(spec.headingSize)}</span>
      <span class="typo-sample" style="font-size:${esc(spec.headingSize)};font-weight:${esc(spec.headingWeight)}">Heading Sample</span>
    </div>
    <div class="typo-row">
      <span class="typo-label">${esc(spec.bodySize)}</span>
      <span class="typo-sample" style="font-size:${esc(spec.bodySize)}">Body text sample. The quick brown fox jumps over the lazy dog.</span>
    </div>
    <div class="typo-row">
      <span class="typo-label">${esc(spec.captionSize)}</span>
      <span class="typo-sample" style="font-size:${esc(spec.captionSize)}">Caption sample. Secondary metadata and labels.</span>
    </div>
  </div>
</section>

<section class="section">
  <div class="section-label">Colors</div>
  <div class="swatch-grid">
    ${palette.map(c => `
    <div class="swatch">
      <div class="swatch-chip" style="background:${esc(c.hex)}"></div>
      <div>
        <div class="swatch-label">${esc(c.name)}</div>
        <div class="swatch-value">${esc(c.hex)}</div>
      </div>
    </div>`).join("")}
  </div>
</section>

<div class="split">
  <div class="split-block">
    <h3>Visual rhythm</h3>
    <p>Spacing tokens control density and whitespace. Small (${esc(spec.spaceSm)}), medium (${esc(spec.spaceMd)}), and large (${esc(spec.spaceLg)}) spacings define the layout rhythm. Border radii range from ${esc(spec.radiusSm)} to pill (${esc(spec.radiusPill)}).</p>
  </div>
  <div class="split-block">
    <h3>Interactive elements</h3>
    <p>Buttons use ${esc(spec.btnRadius)} radius. Primary buttons use the brand color with ${esc(spec.btnColor)} text. Cards use the surface background with ${esc(spec.radiusLg)} rounding and subtle borders.</p>
  </div>
</div>

<footer class="footer">
  ${esc(spec.slug)} &middot; Generated from DESIGN.md
</footer>

</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
