/** Whole action ids and the label the strip showed while they ran. */
const ACTION_LABELS: Record<string, string> = {
  apply_uninstall: "uninstall",
  rollback_setup_transaction: "rollback",
};

/** Action ids followed by the task's own label ("apply_setup update claude"): what to put in front of that label. */
const ACTION_PREFIXES: Record<string, string> = {
  apply_setup: "",
  apply_rules_conversion: "convert ",
};

/**
 * The display name of an `ActionResult.action`: the same words the output strip showed while the task ran, so a
 * finished task is not renamed. Unknown ids keep their words with dashes instead of underscores.
 */
export function actionLabel(action: string): string {
  const exact = ACTION_LABELS[action];
  if (exact) return exact;
  const space = action.indexOf(" ");
  const id = space === -1 ? action : action.slice(0, space);
  const rest = space === -1 ? "" : action.slice(space + 1).trim();
  const prefix = ACTION_PREFIXES[id];
  if (prefix !== undefined && rest) return `${prefix}${rest}`;
  return action.replace(/_/g, "-");
}
