import { unitLine, type FileConflictModel } from "../lib/fileConflicts";
import { Glyph } from "../ui/Glyph";
import { Kv, type KvItem } from "../ui/Kv";

/** The marker in front of the unit the keys act on. */
const MARK = "▸";

/**
 * The skill or agent files of a surface that are in conflict or that the user keeps, in the detail pane: one line
 * per unit (what, where, why or since when) with the one the keys act on marked. What to do about them is the
 * status bar's job (`c` `d` `m` appear while the row is selected).
 */
export function FileConflictSummary({
  model,
  markedKey,
  error,
}: {
  model: FileConflictModel;
  markedKey: string | null;
  error?: string | null;
}) {
  const marked = model.units.find(unit => unit.key === markedKey) ?? model.units[0];
  const items: KvItem[] = [
    ...model.units.map((unit): KvItem => {
      const line = unitLine(unit);
      return {
        id: unit.key,
        label: unit === marked ? MARK : " ",
        value: line.text,
        tone: line.tone,
        wrap: true,
      };
    }),
    ...(model.more > 0 ? [{ id: "more", label: "", value: `+${model.more} more`, tone: "dim" as const }] : []),
  ];
  return (
    <>
      <div className="group pane-group">{model.conflicts > 0 ? "your files in conflict" : "your files"}</div>
      <Kv items={items} aria-label="Files in conflict or kept" />
      {error && (
        <p className="c-fail pane-note" role="alert">
          <Glyph name="fail" tone="fail" /> {error}
        </p>
      )}
    </>
  );
}
