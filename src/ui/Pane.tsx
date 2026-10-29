import { createContext, useContext, useId, type FocusEvent, type ReactNode } from "react";
import { cx } from "./tone";

export const PaneContext = createContext<string | null>(null);

/** Id of the enclosing Pane (`data-pane-id`), or null outside one. */
export function usePaneId(): string | null {
  return useContext(PaneContext);
}

export interface PaneProps {
  /** Stable id: `data-pane-id`, and the `paneId` bindings use to be active while this pane has focus. */
  id: string;
  title: ReactNode;
  /** Accessible name of the pane. Defaults to `title` when it is a string. */
  label?: string;
  /** Muted text after the title ("· 5", "· claude"). */
  meta?: ReactNode;
  /**
   * Static footer content (a confirm line, a copy-path control, navigation text). Key hints do not belong
   * here: bindings with `paneId === id` are active while the pane has focus; the owner renders their buttons.
   */
  footer?: ReactNode;
  /** The pane that `focusDefaultPane()` picks after a view switch. Default: the first pane in DOM order. */
  defaultFocus?: boolean;
  /**
   * Make the body the keyboard focus target (tabIndex=0, scrollable with arrows). Use for panes without a
   * PaneList or input; panes with a listbox leave this off because the listbox is the primary target.
   */
  scrollable?: boolean;
  /**
   * `card`: the Bläck review card: a titled hairline card whose title row sits in the flow (no notch on the border)
   * and whose footer is the action bar. The default keeps the terminal pane the other views still use.
   */
  variant?: "card";
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * `section.pane[data-pane-id][data-keyscope="pane"]` with a title notch, a body and an optional static footer.
 * Focus highlight is CSS (`.pane:focus-within`). Clicking dead space inside the pane moves focus to
 * its primary target so `j`/`k` keep working.
 */
export function Pane({
  id,
  title,
  label,
  meta,
  footer,
  defaultFocus,
  scrollable,
  variant,
  className,
  bodyClassName,
  children,
}: PaneProps) {
  const titleId = useId();
  const accessibleName = label ?? (typeof title === "string" ? title : undefined);

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const primary = event.currentTarget.querySelector<HTMLElement>("[data-pane-primary]");
    if (primary) primary.focus();
  };

  return (
    <PaneContext.Provider value={id}>
      <section
        className={cx("pane", variant && `pane-${variant}`, className)}
        data-pane-id={id}
        data-pane-default={defaultFocus ? "" : undefined}
        data-keyscope="pane"
        aria-label={accessibleName}
        aria-labelledby={accessibleName ? undefined : titleId}
        tabIndex={-1}
        onFocus={onFocus}
      >
        <span className="pane-title" id={titleId}>
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
        {footer && <div className="pane-foot">{footer}</div>}
      </section>
    </PaneContext.Provider>
  );
}
