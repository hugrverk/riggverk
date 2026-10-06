import type { RulesKind, RulesModel } from "../lib/rulesView";
import { Glyph } from "../ui/Glyph";
import { Kv, type KvItem } from "../ui/Kv";

const NEXT_STEP: Partial<Record<RulesKind, string>> = {
  update: "An update replaces the base block and keeps your refinements. d shows what changes.",
  conflict: "Update skips this file; nothing was changed. d shows your edits, v previews a conversion that keeps them below the block, m leaves the file as is.",
  managed: "Base updates are not applied while you manage this file. d shows them, v previews converting it, m hands it back to the app.",
  malformed: "Fix the markers by hand. The app never rewrites a file whose block it cannot split.",
};

/** The rules file of a harness in the surfaces pane: layout, what an update keeps, and for a conflict why. */
export function RulesSummary({ model, error }: { model: RulesModel; error?: string | null }) {
  const items: KvItem[] = [
    { label: "layout", value: model.layout },
    {
      label: "refinements",
      value: model.refinements,
      tone: model.refinements === "none" ? "dim" : "ok",
    },
    { label: "state", value: model.headline, tone: model.tone, wrap: true },
    ...(model.reason ? [{ label: "why", value: model.reason, tone: model.kind === "managed" ? ("dim" as const) : model.tone, wrap: true }] : []),
  ];
  const next = NEXT_STEP[model.kind];
  return (
    <>
      <div className="group pane-group">rules file</div>
      <Kv items={items} aria-label="Rules file" />
      {next && <p className="c-dim pane-note">{next}</p>}
      {error && (
        <p className="c-fail pane-note" role="alert">
          <Glyph name="fail" tone="fail" /> {error}
        </p>
      )}
    </>
  );
}
