import type { RulesModel } from "../lib/rulesView";
import { Glyph } from "../ui/Glyph";
import { Kv, type KvItem } from "../ui/Kv";

/**
 * The rules file of a harness in the detail pane: layout, what an update keeps, and for a conflict why. What
 * to do about it is the status bar's job (`d` `v` `m` appear while the rules row is selected); only a file
 * nothing in the app can fix says so here.
 */
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
    ...(model.kind === "malformed"
      ? [{ label: "fix", value: "fix the markers by hand; the app never rewrites a file whose block it cannot split", tone: "dim" as const, wrap: true }]
      : []),
  ];
  return (
    <>
      <div className="group pane-group">rules file</div>
      <Kv items={items} aria-label="Rules file" />
      {error && (
        <p className="c-fail pane-note" role="alert">
          <Glyph name="fail" tone="fail" /> {error}
        </p>
      )}
    </>
  );
}
