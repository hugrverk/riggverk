import { createContext, useContext, useId, type FocusEvent, type ReactNode } from "react";
import { useKeymapEntries } from "../keyboard/context";
import { evaluateWhen, paneHintEntries } from "../keyboard/registry";
import { BindingActionKey } from "./BindingActionKey";
import { cx } from "./tone";

const PaneContext = createContext<string | null>(null);

/** Id of the enclosing Pane (`data-pane-id`), or null outside one. */
export function usePaneId(): string | null {
  return useContext(PaneContext);
}

export interface PaneProps {
  /** Stable id: `data-pane-id`, and the `paneId` bindings use to show up in this pane's footer. */
  id: string;
  /** Number shown as `[n]` before the title. */
  index?: number;
  title: ReactNode;
  /** Accessible name of the pane. Defaults to `title` when it is a string. */
  label?: string;
  /** Muted text after the title ("· 5", "· claude"). */
  meta?: ReactNode;
  /** Static footer content (plain hints). Bindings with `paneId === id` and a `hint` render automatically as ActionKeys. */
  footer?: ReactNode;
  /** The pane that `focusDefaultPane()` picks after a view switch. Default: the first pane in DOM order. */
  defaultFocus?: boolean;
  /**
   * Make the body the keyboard focus target (tabIndex=0, scrollable with arrows). Use for panes without a
   * PaneList or input; panes with a listbox leave this off because the listbox is the primary target.
   */
  scrollable?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * `section.pane[data-pane-id][data-keyscope="pane"]` with a title notch, a body and a footer.
 * Focus highlight is CSS (`.pane:focus-within`). Clicking dead space inside the pane moves focus to
 * its primary target so `j`/`k` keep working.
 */
export function Pane({
  id,
  index,
  title,
  label,
  meta,
  footer,
  defaultFocus,
  scrollable,
  className,
  bodyClassName,
  children,
}: PaneProps) {
  const titleId = useId();
  const entries = useKeymapEntries();
  const hints = paneHintEntries(entries, id).filter(entry => {
    const { active, disabledReason } = evaluateWhen(entry.binding);
    return active || disabledReason !== null;
  });
  const accessibleName = label ?? (typeof title === "string" ? title : undefined);

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const primary = event.currentTarget.querySelector<HTMLElement>("[data-pane-primary]");
    if (primary) primary.focus();
  };

  return (
    <PaneContext.Provider value={id}>
      <section
        className={cx("pane", className)}
        data-pane-id={id}
        data-pane-default={defaultFocus ? "" : undefined}
        data-keyscope="pane"
        aria-label={accessibleName}
        aria-labelledby={accessibleName ? undefined : titleId}
        tabIndex={-1}
        onFocus={onFocus}
      >
        <span className="pane-title" id={titleId}>
          {index !== undefined && <span className="k">[{index}]</span>}
          {index !== undefined && " "}
          <b>{title}</b>
          {meta !== undefined && meta !== null && <> {meta}</>}
        </span>
        <div
          className={cx("pane-body", bodyClassName)}
          {...(scrollable
            ? { tabIndex: 0, role: "group", "aria-label": accessibleName, "aria-labelledby": accessibleName ? undefined : titleId, "data-pane-primary": "" }
            : {})}
        >
          {children}
        </div>
        {(footer || hints.length > 0) && (
          <div className="pane-foot">
            {hints.map(entry => (
              <BindingActionKey key={entry.binding.id} entry={entry} />
            ))}
            {footer}
          </div>
        )}
      </section>
    </PaneContext.Provider>
  );
}
