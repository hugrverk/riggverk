import type { CodexConfigModel } from "../lib/codexConfig";
import { Glyph } from "../ui/Glyph";
import { Kv, type KvItem } from "../ui/Kv";

/**
 * The enforced keys of the Codex config that the user keeps, or that differ from Riggverk's, in the detail pane.
 * What to do about them is the status bar's job (`m` keeps them, or hands them back, while the row is selected).
 */
export function CodexConfigSummary({ model, error }: { model: CodexConfigModel; error?: string | null }) {
  const items: KvItem[] = [
    ...model.kept.map((item, index): KvItem => ({
      id: `kept-${item.key}`,
      label: index === 0 ? "you keep" : "",
      value: `${item.key} = ${item.value}`,
      tone: "warn",
      wrap: true,
    })),
    ...model.differing.map((item, index): KvItem => ({
      id: `differs-${item.key}`,
      label: index === 0 ? "differs" : "",
      value: `${item.key} = ${item.value}`,
      tone: "warn",
      wrap: true,
    })),
    ...(model.kept.length > 0
      ? [{ id: "others", label: "others", value: "the other managed keys follow Riggverk", tone: "dim" as const, wrap: true }]
      : []),
  ];
  return (
    <>
      <div className="group pane-group">config keys</div>
      <Kv items={items} aria-label="Codex config keys" />
      {error && (
        <p className="c-fail pane-note" role="alert">
          <Glyph name="fail" tone="fail" /> {error}
        </p>
      )}
    </>
  );
}
