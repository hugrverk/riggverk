import { useId, type ReactNode } from "react";
import type { FileConflictActions } from "../../hooks/useFileConflictActions";
import type { FileConflictFlow } from "../../hooks/useFileConflictFlow";
import type { Binding } from "../../keyboard/registry";
import { useKeymap } from "../../keyboard/useKeymap";
import {
  fileGates,
  filesWhy,
  nextUnitKey,
  unitDetail,
  type FileConflictModel,
  type FileGateContext,
} from "../../lib/fileConflicts";
import type { FileUnit } from "../../types";
import { cx } from "../../ui/tone";
import { TButton } from "../../ui/TButton";
import { FileSections } from "../ConflictPane";
import { CellButton } from "../harness/CellButton";
import { ActivityLoader } from "../TerminalOutput";
import { ChoiceCards, type Choice } from "./ChoiceCards";
import { Fold } from "./Fold";

export interface FilesDecisionProps {
  model: FileConflictModel;
  flow: FileConflictFlow;
  files: FileConflictActions;
  /** The unit the page keys act on. */
  markedKey: string | null;
  onMark: (key: string) => void;
  /** The workspace-folder and running-task facts the buttons wait for. */
  context: FileGateContext;
  /** The page keys act on this cell: key caps show on its buttons. */
  active: boolean;
  /** Facts about the surface itself (the folders a skill is read from), shown under the files and above the fold-out. */
  aside?: ReactNode;
}

const CONSEQUENCES = ["Preview first", "Backed up", "Undo any time"] as const;

const ERROR_HINT = "The diff could not be computed. Nothing was written.";

/**
 * The skill or agent files of a surface that are in conflict (or that the user keeps) as a decision: the why line, one
 * row per unit (name, where, why) with its own Compare, "Use Riggverk’s version…" and Keep mine / Hand back, and
 * Compare folded out inline under the list: a read-only side-by-side diff of that unit (`preview_file_diff`) and the
 * ways out as cards. "Use Riggverk’s version…" opens the take-bundled preview, where only `y` applies; Keep mine asks
 * first. Escape closes the fold.
 */
export function FilesDecision({ model, flow, files, markedKey, onMark, context, active, aside }: FilesDecisionProps) {
  const foldId = `${useId()}-compare`;
  const state = flow.state;
  const open = flow.inline && state.status !== "idle" && state.surface === model.surface;
  const shownKey = open ? state.unit : null;
  const shown = model.units.find(unit => unit.key === shownKey);
  const marked = model.units.find(unit => unit.key === markedKey) ?? model.units[0];
  const nextKey = model.units.length > 1 ? nextUnitKey(model, markedKey) : null;

  const escape: Binding = {
    id: `files.${model.surface}.compare.escape`,
    keys: "Escape",
    title: "Close the comparison",
    group: "Conflicts",
    scope: "global",
    when: () => open,
    run: () => flow.close(),
  };
  useKeymap([escape]);

  const choicesFor = (unit: FileUnit): Choice[] => {
    const gates = fileGates(model, unit, context);
    return [
      {
        id: "bundled",
        title: "Use Riggverk's version",
        sub: "Replaces your file with the one Riggverk ships. Yours is backed up first.",
        keyName: "b",
        disabled: gates.bundled.reason ?? false,
        onChoose: () => files.runOnUnit("bundled", model.surface, unit.key),
      },
      ...(gates.keep.visible
        ? [
            {
              id: "keep",
              title: "Keep mine",
              sub: "Riggverk never writes your version. Bundled updates stay visible.",
              keyName: "m",
              disabled: gates.keep.reason ?? false,
              onChoose: () => files.runOnUnit("mine", model.surface, unit.key),
            },
          ]
        : []),
      ...(gates.manage.visible
        ? [
            {
              id: "hand-back",
              title: "Hand back",
              sub: "Riggverk manages this file again and proposes the bundled version, with a preview first.",
              keyName: "m",
              disabled: gates.manage.reason ?? false,
              onChoose: () => files.runOnUnit("manage", model.surface, unit.key),
            },
          ]
        : []),
    ];
  };

  return (
    <>
      <p className="hp-why">{filesWhy(model)}</p>
      {files.error && (
        <p className="hp-error" role="alert">
          {files.error}
        </p>
      )}
      <ul className="hp-units" aria-label="Files in conflict or kept">
        {model.units.map(unit => {
          const gates = fileGates(model, unit, context);
          const isMarked = unit === marked;
          const unitOpen = open && shownKey === unit.key;
          return (
            <li key={unit.key} className={cx("hp-unit", isMarked && "is-marked")} data-unit={unit.key} data-marked={isMarked || undefined}>
              <div className="hp-unit-id">
                <b>
                  {isMarked && model.units.length > 1 && (
                    <span className="hp-unit-mark" aria-hidden="true">
                      ▸{" "}
                    </span>
                  )}
                  {unit.name}
                </b>
                <span className="hp-unit-detail">{unitDetail(unit)}</span>
              </div>
              <div className="hp-acts">
                <CellButton
                  gate={gates.diff}
                  keyName="d"
                  active={active && isMarked}
                  expanded={unitOpen}
                  controls={foldId}
                  onClick={() => files.toggleDiffOn(model.surface, unit.key)}
                >
                  Compare
                </CellButton>
                <CellButton
                  gate={gates.bundled}
                  keyName="b"
                  active={active && isMarked}
                  onClick={() => files.runOnUnit("bundled", model.surface, unit.key)}
                >
                  Use Riggverk's version…
                </CellButton>
                <CellButton gate={gates.keep} keyName="m" active={active && isMarked} onClick={() => files.runOnUnit("mine", model.surface, unit.key)}>
                  Keep mine
                </CellButton>
                <CellButton gate={gates.manage} keyName="m" active={active && isMarked} onClick={() => files.runOnUnit("manage", model.surface, unit.key)}>
                  Hand back
                </CellButton>
              </div>
            </li>
          );
        })}
      </ul>
      {model.more > 0 && <p className="hp-sbs-note">+{model.more} more</p>}
      {nextKey && (
        <div className="hp-acts">
          <TButton keys={active ? ["c"] : []} shortcut={active ? "c" : undefined} onClick={() => onMark(nextKey)}>
            Next file
          </TButton>
        </div>
      )}
      {aside}
      {open && (
        <Fold id={foldId} label={`Compare ${shown?.name ?? "the files"} with Riggverk's version`}>
          {state.status === "loading" && (
            <p className="hp-fold-status" role="status">
              <ActivityLoader />
              <span>Computing the diff…</span>
            </p>
          )}
          {state.status === "error" && (
            <div className="hp-fold-error">
              <p className="hp-error" role="alert">
                {state.message}
              </p>
              <p className="hp-sbs-note">{ERROR_HINT}</p>
              <div className="hp-acts">
                <TButton keys={[]} onClick={() => void flow.retry()}>
                  Try again
                </TButton>
                <TButton keys={["Esc"]} onClick={flow.close}>
                  Close
                </TButton>
              </div>
            </div>
          )}
          {state.status === "diff" && (
            <>
              <p className="hp-sbs-intro">Your files on the left, the ones Riggverk ships on the right. Nothing is written.</p>
              {shown?.state === "kept" && (
                <p className="hp-sbs-note">
                  You keep your version: updates never write it
                  {shown.wanted ? (shown.bundle_changed ? "; the bundled file changed since you kept it." : "; the bundled file is unchanged since you kept it.") : "."}
                </p>
              )}
              <FileSections diff={state.diff} unit={shown} layout="split" />
              {shown && <ChoiceCards label={`Resolve ${shown.name}`} choices={choicesFor(shown)} consequences={CONSEQUENCES} active={active && shown === marked} />}
            </>
          )}
        </Fold>
      )}
    </>
  );
}
