import type { ReactNode } from "react";
import { TButton, type TButtonProps } from "../../ui/TButton";

/** Whether an action is offered, and why it cannot run right now (the same shape as the rules, files and Codex gates). */
export interface CellGate {
  visible: boolean;
  reason: string | null;
}

export interface CellButtonProps {
  gate: CellGate;
  /** The page key that does the same; shown on the button (and in `aria-keyshortcuts`) only while the cell is the active one. */
  keyName: string;
  active: boolean;
  variant?: TButtonProps["variant"];
  onClick: () => void;
  children: ReactNode;
}

/**
 * An action of a harness cell as a button. It exists exactly when the key would be offered (`gate.visible`) and is
 * disabled, with the reason as its tooltip, exactly when the key would refuse. Click and key run the same code.
 */
export function CellButton({ gate, keyName, active, variant, onClick, children }: CellButtonProps) {
  if (!gate.visible) return null;
  return (
    <TButton
      keys={active ? [keyName] : []}
      shortcut={active ? keyName : undefined}
      variant={variant}
      disabled={gate.reason ?? false}
      onClick={onClick}
    >
      {children}
    </TButton>
  );
}
