import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithShell } from "../../test/renderWithShell";
import { LibraryList, SELECT_DELAY_MS, type LibraryListProps } from "./LibraryList";

interface Row {
  id: string;
  name: string;
}

const ROWS: Row[] = [
  { id: "a", name: "alpha" },
  { id: "b", name: "bravo" },
  { id: "c", name: "charlie" },
];

function List(props: Partial<LibraryListProps<Row>>) {
  return (
    <LibraryList<Row>
      label="Docs"
      items={ROWS}
      getKey={row => row.id}
      renderItem={row => <span>{row.name}</span>}
      activeKey="a"
      followCursor
      onSelect={() => {}}
      onActivate={() => {}}
      {...props}
    />
  );
}

function press(key: string) {
  fireEvent.keyDown(screen.getByRole("listbox", { name: "Docs" }), { key });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LibraryList cursor preview", () => {
  it("opens the row the cursor rests on after the pause", () => {
    const onSelect = vi.fn();
    renderWithShell(<List onSelect={onSelect} />);
    press("j");
    expect(onSelect).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(SELECT_DELAY_MS));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("does not open a row when the open item turned dirty during the pause", () => {
    const onSelect = vi.fn();
    const { rerender } = renderWithShell(<List onSelect={onSelect} followCursor />);
    press("j");
    // The user typed into the open item right after moving the cursor: opening B would raise the discard dialog.
    rerender(<List onSelect={onSelect} followCursor={false} />);
    act(() => void vi.advanceTimersByTime(SELECT_DELAY_MS * 2));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("only moves the cursor while the open item is dirty", () => {
    const onSelect = vi.fn();
    renderWithShell(<List onSelect={onSelect} followCursor={false} />);
    press("j");
    act(() => void vi.advanceTimersByTime(SELECT_DELAY_MS * 2));
    expect(onSelect).not.toHaveBeenCalled();
    const cursorId = screen.getByRole("listbox", { name: "Docs" }).getAttribute("aria-activedescendant");
    expect(document.getElementById(cursorId!)?.textContent).toContain("bravo");
  });
});
