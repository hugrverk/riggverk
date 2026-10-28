import { useId } from "react";
import type { RulesActions } from "../../hooks/useRulesActions";
import type { RulesFlow } from "../../hooks/useRulesFlow";
import type { Binding } from "../../keyboard/registry";
import { useKeymap } from "../../keyboard/useKeymap";
import { rulesWhy, type RulesGates, type RulesModel } from "../../lib/rulesView";
import { Kv, type KvItem } from "../../ui/Kv";
import type { RulesDiffView } from "../../types";
import { CellButton } from "../harness/CellButton";
import { TButton } from "../../ui/TButton";
import { ActivityLoader } from "../TerminalOutput";
import { ChoiceCards, type Choice } from "./ChoiceCards";
import { Fold } from "./Fold";
import { SideBySideDiff, type DiffNote } from "./SideBySideDiff";

export interface RulesDecisionProps {
  model: RulesModel;
  /** "Claude Code". */
  harnessLabel: string;
  /** "CLAUDE.md". */
  fileName: string;
  flow: RulesFlow;
  rules: RulesActions;
  gates: RulesGates;
  /** The page keys act on this cell: key caps show on its buttons. */
  active: boolean;
}

const CONSEQUENCES = ["Preview of the exact file first", "Backed up", "Undo any time"] as const;

const ERROR_HINT = "The diff could not be computed. Nothing was written.";

function diffNotes(diff: RulesDiffView): DiffNote[] {
  return [
    ...(diff.note ? [{ text: diff.note, tone: diff.applicable ? ("dim" as const) : ("warn" as const) }] : []),
    ...(diff.truncated ? [{ text: "The diff is cut at 64 KB; the rest is not shown.", tone: "warn" as const }] : []),
  ];
}

/**
 * The rules file of a harness as a decision: the why line, the buttons (Compare, Merge in updates…, Keep mine / Hand
 * back) and, under them, Compare folded out inline: a read-only side-by-side diff (`preview_rules_diff`) and the two
 * ways out as cards. Compare never writes and needs no token. Merge in updates opens the preview of the exact file (the
 * conversion review, where only `y` applies); Keep mine asks first. Escape closes the fold.
 */
export function RulesDecision({ model, harnessLabel, fileName, flow, rules, gates, active }: RulesDecisionProps) {
  const foldId = `${useId()}-compare`;
  const state = flow.state;
  const open = flow.inline && state.status !== "idle" && state.surface === model.surface;

  const escape: Binding = {
    id: `rules.${model.surface}.compare.escape`,
    keys: "Escape",
    title: "Close the comparison",
    group: "Rules",
    scope: "global",
    when: () => open,
    run: () => flow.close(),
  };
  useKeymap([escape]);

  const facts: KvItem[] =
    model.kind === "conflict"
      ? []
      : [
          { label: "layout", value: model.layout },
          { label: "refinements", value: model.refinements, tone: model.refinements === "none" ? "dim" : "ok" },
          // The exact rule that failed (the marker, the file in the way) is what a fix by hand starts from.
          ...(model.reason ? [{ label: "why", value: model.reason, tone: "dim" as const, wrap: true }] : []),
        ];

  const choices: Choice[] = [
    ...(model.convertible && gates.convert.visible
      ? [
          {
            id: "merge",
            title: "Merge in updates",
            sub: "Riggverk’s rules go in a managed block. Your changed sections move below it and stay yours.",
            keyName: "v",
            disabled: gates.convert.reason ?? false,
            onChoose: () => rules.run("convert"),
          },
        ]
      : []),
    ...(gates.leave.visible
      ? [
          {
            id: "keep",
            title: "Keep mine",
            sub: "Riggverk never writes this file. You won’t get rule updates until you change your mind.",
            keyName: "m",
            disabled: gates.leave.reason ?? false,
            onChoose: () => rules.run("leave"),
          },
        ]
      : []),
    ...(gates.manage.visible
      ? [
          {
            id: "hand-back",
            title: "Hand back",
            sub: "Riggverk manages this file again and proposes the newest rules, with a preview first.",
            keyName: "m",
            disabled: gates.manage.reason ?? false,
            onChoose: () => rules.run("manage"),
          },
        ]
      : []),
  ];

  const edits = state.status === "diff" && state.diff.mode === "edits";
  const why = rulesWhy(model, harnessLabel, fileName);

  return (
    <>
      {why && <p className="hp-why">{why}</p>}
      {facts.length > 0 && <Kv items={facts} className="hp-kv" aria-label="Rules file" />}
      {rules.error && (
        <p className="hp-error" role="alert">
          {rules.error}
        </p>
      )}
      <div className="hp-acts">
        <CellButton gate={gates.diff} keyName="d" active={active} expanded={open} controls={foldId} onClick={rules.toggleDiff}>
          Compare
        </CellButton>
        <CellButton
          gate={gates.convert}
          keyName="v"
          active={active}
          variant={model.kind === "conflict" ? "primary" : undefined}
          onClick={() => rules.run("convert")}
        >
          Merge in updates…
        </CellButton>
        <CellButton gate={gates.leave} keyName="m" active={active} onClick={() => rules.run("leave")}>
          Keep mine
        </CellButton>
        <CellButton gate={gates.manage} keyName="m" active={active} onClick={() => rules.run("manage")}>
          Hand back
        </CellButton>
      </div>
      {open && (
        <Fold id={foldId} label={`Compare ${fileName} with Riggverk’s rules`}>
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
              <SideBySideDiff
                diff={state.diff.diff}
                label={`${state.diff.from_label} to ${state.diff.to_label}`}
                empty={edits ? "No differences from the shipped base." : "No differences: nothing would change."}
                intro={
                  edits
                    ? "What you changed: the closest shipped base on the left, your file on the right."
                    : "What an update would do: your file on the left, the current base on the right."
                }
                notes={diffNotes(state.diff)}
              />
              <p className="hp-fold-tools">
                <TButton keys={active ? ["t"] : []} shortcut={active ? "t" : undefined} onClick={() => void flow.switchDiffMode()}>
                  {edits ? "Show the update instead" : "Show my edits instead"}
                </TButton>
              </p>
              {choices.length > 0 && (
                <ChoiceCards label={`Resolve ${fileName}`} choices={choices} consequences={CONSEQUENCES} active={active} />
              )}
            </>
          )}
        </Fold>
      )}
    </>
  );
}
