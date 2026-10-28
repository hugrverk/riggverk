import type { CodexConfigActions } from "../../hooks/useCodexConfigActions";
import {
  CODEX_CREATE_ONLY_NOTE,
  codexKeyRows,
  codexWhy,
  keyNames,
  type CodexConfigGates,
  type CodexConfigModel,
} from "../../lib/codexConfig";
import { CellButton } from "../harness/CellButton";
import { ChoiceCards, type Choice } from "./ChoiceCards";

export interface CodexConfigDecisionProps {
  model: CodexConfigModel;
  gates: CodexConfigGates;
  codexConfig: CodexConfigActions;
  /** The page keys act on this cell: key caps show on its buttons. */
  active: boolean;
}

const CONSEQUENCES = ["Preview first", "Backed up", "Undo any time"] as const;

/** "approvals_reviewer to user", "approvals_reviewer to user and sandbox_mode to workspace-write". */
function setsText(model: CodexConfigModel): string {
  const parts = model.differing.map(item => {
    const riggverk = (model.expected ?? []).find(expected => expected.key === item.key)?.value;
    return riggverk === undefined ? item.key : `${item.key} to ${riggverk}`;
  });
  const everyValueKnown = model.differing.every(item => (model.expected ?? []).some(expected => expected.key === item.key));
  const list = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return everyValueKnown ? list : `${keyNames(model.differing)} to Riggverk’s ${model.differing.length === 1 ? "value" : "values"}`;
}

/**
 * The enforced Codex config keys as a decision: the why line, the table of the managed keys (key, Riggverk’s value,
 * yours; a differing value is bold with the filled square, a matching key has a check), and the two ways out as cards.
 * Keep mine asks first and writes the choice only; Use Riggverk defaults opens the preview of the exact key changes,
 * where only `y` applies. Once everything that differs is kept, the one way out is Hand back.
 */
export function CodexConfigDecision({ model, gates, codexConfig, active }: CodexConfigDecisionProps) {
  const rows = codexKeyRows(model);
  const others = Math.max(0, rows.length - model.differing.length);

  const choices: Choice[] = [
    ...(gates.keep.visible
      ? [
          {
            id: "keep",
            title: "Keep mine",
            sub: `${keyNames(model.differing)} stays as it is. Riggverk still manages the other ${others} ${others === 1 ? "key" : "keys"}.`,
            keyName: "m",
            disabled: gates.keep.reason ?? false,
            onChoose: codexConfig.run,
          },
        ]
      : []),
    ...(gates.defaults.visible
      ? [
          {
            id: "defaults",
            title: "Use Riggverk defaults",
            sub: `Sets ${setsText(model)}. Everything else keeps its value and place.`,
            keyName: "b",
            disabled: gates.defaults.reason ?? false,
            onChoose: codexConfig.runDefaults,
          },
        ]
      : []),
  ];

  return (
    <>
      <p className="hp-why">{codexWhy(model)}</p>
      <div>
        <table className="hp-keytable" aria-label="Managed Codex settings">
          <thead>
            <tr>
              <th scope="col">Managed key</th>
              <th scope="col">Riggverk</th>
              <th scope="col">Yours</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key} data-key-state={row.state}>
                <th scope="row">{row.key}</th>
                <td className={row.state === "same" ? "is-same" : undefined}>{row.riggverk ?? (row.state === "same" ? "default" : "unknown")}</td>
                <td className={row.state === "differs" ? "is-differs" : "is-same"}>
                  {row.state === "differs" && <span className="visually-hidden">differs: </span>}
                  {row.state === "same" ? "same ✓" : row.yours}
                  {row.state === "kept" && <span className="hp-keytable-kept"> (kept)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hp-sbs-note">{CODEX_CREATE_ONLY_NOTE}</p>
      </div>
      {codexConfig.error && (
        <p className="hp-error" role="alert">
          {codexConfig.error}
        </p>
      )}
      {choices.length > 0 && <ChoiceCards label="Resolve the Codex config" choices={choices} consequences={CONSEQUENCES} active={active} />}
      {gates.handBack.visible && (
        <div className="hp-acts">
          <CellButton gate={gates.handBack} keyName="m" active={active} onClick={codexConfig.run}>
            Hand back
          </CellButton>
        </div>
      )}
    </>
  );
}
