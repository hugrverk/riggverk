import { useId, type ReactNode } from "react";

export interface Choice {
  id: string;
  title: string;
  /** One sentence: what choosing does. */
  sub: ReactNode;
  /** true or a reason string: rendered aria-disabled, never calls `onChoose`. The reason becomes the tooltip. */
  disabled?: boolean | string;
  /** The page key that does the same, shown on the card while its cell is the active one. */
  keyName?: string;
  onChoose: () => void;
}

export interface ChoiceCardsProps {
  /** Accessible name of the group ("Resolve CLAUDE.md"). */
  label: string;
  choices: readonly Choice[];
  /** The facts under the cards ("Preview of the exact file first", "Backed up", "Undo any time"). */
  consequences?: readonly string[];
  /** The keys act on this cell: the key caps show. */
  active?: boolean;
}

/**
 * The two ways out of a decision as cards: a bold title, one sentence, and under them what is promised whichever is
 * chosen. A card is a real button; choosing never writes by itself: it opens the preview (Merge in updates, Use
 * Riggverk defaults) or asks first (Keep mine). Like `TButton`, a click leaves focus where it was and a disabled card
 * stays focusable with its reason as the tooltip.
 */
export function ChoiceCards({ label, choices, consequences = [], active = false }: ChoiceCardsProps) {
  const baseId = useId();
  return (
    <div className="hp-decision-choices">
      <div className="hp-choices" role="group" aria-label={label}>
        {choices.map(choice => {
          const disabled = choice.disabled ?? false;
          const isDisabled = disabled !== false;
          // The name is the title; the sentence under it is the description, so a card reads as a short button name.
          const titleId = `${baseId}-${choice.id}-t`;
          const subId = `${baseId}-${choice.id}-s`;
          return (
            <button
              key={choice.id}
              type="button"
              className="hp-choice"
              aria-labelledby={titleId}
              aria-describedby={subId}
              aria-disabled={isDisabled || undefined}
              aria-keyshortcuts={active ? choice.keyName : undefined}
              title={typeof disabled === "string" ? disabled : undefined}
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                if (!isDisabled) choice.onChoose();
              }}
            >
              <span className="hp-choice-t" id={titleId}>
                <span>{choice.title}</span>
                {active && choice.keyName && <kbd aria-hidden="true">{choice.keyName}</kbd>}
              </span>
              <span className="hp-choice-s" id={subId}>
                {choice.sub}
              </span>
            </button>
          );
        })}
      </div>
      {consequences.length > 0 && (
        <p className="hp-conseq">
          {consequences.map(text => (
            <span key={text}>{text}</span>
          ))}
        </p>
      )}
    </div>
  );
}
