import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithShell } from "../test/renderWithShell";
import { useKeymapEntries, useKeymapState } from "./context";
import type { Binding } from "./registry";
import { useKeymap } from "./useKeymap";

function binding(overrides: Partial<Binding> & Pick<Binding, "id" | "keys">): Binding {
  return { title: overrides.id, scope: "global", run: () => {}, ...overrides };
}

function Harness({ bindings }: { bindings: Binding[] }) {
  useKeymap(bindings);
  const state = useKeymapState();
  return (
    <div>
      <input aria-label="field" />
      <textarea aria-label="area" />
      <button type="button">activator</button>
      <output aria-label="chord">{state.pendingChord.join(" ")}</output>
    </div>
  );
}

function press(target: Element | Document, key: string, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, { key, ...init });
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("KeymapProvider", () => {
  it("fires a global binding from the body and calls preventDefault", () => {
    const run = vi.fn();
    renderWithShell(<Harness bindings={[binding({ id: "t.j", keys: "j", run })]} />);
    const notPrevented = press(document.body, "j");
    expect(run).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it("does not fire printable bindings while typing in an input or textarea, and fires again after blur", () => {
    const run = vi.fn();
    renderWithShell(<Harness bindings={[binding({ id: "t.j", keys: "j", run })]} />);
    const field = screen.getByLabelText("field");
    const area = screen.getByLabelText("area");
    act(() => field.focus());
    press(field, "j");
    press(area, "j");
    expect(run).not.toHaveBeenCalled();
    act(() => field.blur());
    press(document.body, "j");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires inEditable bindings (Escape, Mod+s, Mod+k) inside text fields", () => {
    const esc = vi.fn();
    const save = vi.fn();
    renderWithShell(
      <Harness
        bindings={[
          binding({ id: "t.esc", keys: "Escape", inEditable: true, run: esc }),
          binding({ id: "t.save", keys: "Mod+s", inEditable: true, run: save }),
        ]}
      />,
    );
    const area = screen.getByLabelText("area");
    press(area, "Escape");
    press(area, "s", { ctrlKey: true });
    expect(esc).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("ignores Alt, disallowed Cmd/Ctrl combos and IME composition", () => {
    const run = vi.fn();
    renderWithShell(<Harness bindings={[binding({ id: "t.a", keys: "a", run }), binding({ id: "t.mod-a", keys: "Mod+a", run })]} />);
    press(document.body, "a", { altKey: true });
    press(document.body, "a", { metaKey: true });
    press(document.body, "a", { ctrlKey: true });
    press(document.body, "a", { isComposing: true });
    press(document.body, "a", { keyCode: 229 });
    expect(run).not.toHaveBeenCalled();
  });

  it("matches Mod+s only with the platform modifier", () => {
    const run = vi.fn();
    renderWithShell(<Harness bindings={[binding({ id: "t.save", keys: "Mod+s", run })]} />, { platform: "mac" });
    press(document.body, "s", { ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
    press(document.body, "s", { metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skips events another handler already prevented", () => {
    const run = vi.fn();
    renderWithShell(
      <div onKeyDown={event => event.preventDefault()}>
        <Harness bindings={[binding({ id: "t.j", keys: "j", run })]} />
      </div>,
    );
    press(screen.getByRole("button", { name: "activator" }), "j");
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves Enter and Space on native activators alone but still handles other keys there", () => {
    const enter = vi.fn();
    const j = vi.fn();
    renderWithShell(
      <Harness bindings={[binding({ id: "t.enter", keys: "Enter", run: enter }), binding({ id: "t.j", keys: "j", run: j })]} />,
    );
    const button = screen.getByRole("button", { name: "activator" });
    const notPrevented = press(button, "Enter");
    expect(enter).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
    press(button, "j");
    expect(j).toHaveBeenCalledTimes(1);
    press(document.body, "Enter");
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("does not fire non-overlay bindings while a <dialog> is open", () => {
    const run = vi.fn();
    const overlay = vi.fn();
    renderWithShell(
      <>
        <Harness
          bindings={[
            binding({ id: "t.j", keys: "j", run }),
            binding({ id: "t.close", keys: "Escape", scope: "overlay", run: overlay }),
          ]}
        />
        <dialog open>
          <button type="button">inside</button>
        </dialog>
      </>,
    );
    press(screen.getByRole("button", { name: "inside" }), "j");
    press(document.body, "j");
    expect(run).not.toHaveBeenCalled();
  });

  it("walks scopes innermost first, and a handler returning false lets the next one take the key", () => {
    const calls: string[] = [];
    function Scoped() {
      const listRef = useRef<HTMLUListElement>(null);
      useKeymap(
        [
          binding({ id: "t.global", keys: "x", run: () => void calls.push("global") }),
          binding({ id: "t.pane", keys: "x", scope: "pane", paneId: "p", run: () => void calls.push("pane") }),
          binding({ id: "t.list-skip", keys: "y", scope: "list", run: () => { calls.push("list-skip"); return false; } }),
          binding({ id: "t.pane-y", keys: "y", scope: "pane", paneId: "p", run: () => void calls.push("pane-y") }),
        ],
      );
      useKeymap([binding({ id: "t.list", keys: "x", scope: "list", run: () => void calls.push("list") })], { ref: listRef });
      return (
        <section data-pane-id="p" data-keyscope="pane">
          <ul ref={listRef} data-keyscope="list" tabIndex={0} aria-label="rows" role="listbox" />
          <button type="button">outside list</button>
        </section>
      );
    }
    renderWithShell(<Scoped />);
    press(screen.getByRole("listbox"), "x");
    expect(calls).toEqual(["list"]);
    calls.length = 0;
    press(screen.getByRole("button", { name: "outside list" }), "x");
    expect(calls).toEqual(["pane"]);
    calls.length = 0;
    press(document.body, "x");
    expect(calls).toEqual(["global"]);
    calls.length = 0;
    press(screen.getByRole("listbox"), "y");
    expect(calls).toEqual(["list-skip", "pane-y"]);
  });

  it("limits ref-bound bindings to focus inside the element", () => {
    const run = vi.fn();
    function Bound() {
      const ref = useRef<HTMLDivElement>(null);
      useKeymap([binding({ id: "t.bound", keys: "k", scope: "editor", run })], { ref });
      return (
        <>
          <div ref={ref}>
            <button type="button">in</button>
          </div>
          <button type="button">out</button>
        </>
      );
    }
    renderWithShell(<Bound />);
    press(screen.getByRole("button", { name: "out" }), "k");
    expect(run).not.toHaveBeenCalled();
    press(screen.getByRole("button", { name: "in" }), "k");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("honours when(): false and a disabled-reason string both keep the key from firing", () => {
    const run = vi.fn();
    let state: boolean | string = false;
    const { rerender } = renderWithShell(<Harness bindings={[binding({ id: "t.w", keys: "w", when: () => state, run })]} />);
    press(document.body, "w");
    state = "nothing to write";
    rerender(<Harness bindings={[binding({ id: "t.w", keys: "w", when: () => state, run })]} />);
    press(document.body, "w");
    expect(run).not.toHaveBeenCalled();
    state = true;
    rerender(<Harness bindings={[binding({ id: "t.w", keys: "w", when: () => state, run })]} />);
    press(document.body, "w");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("only repeats bindings that opt in", () => {
    const printable = vi.fn();
    const nav = vi.fn();
    renderWithShell(
      <Harness bindings={[binding({ id: "t.u", keys: "u", run: printable }), binding({ id: "t.j", keys: "j", repeat: true, run: nav })]} />,
    );
    press(document.body, "u", { repeat: true });
    press(document.body, "j", { repeat: true });
    expect(printable).not.toHaveBeenCalled();
    expect(nav).toHaveBeenCalledTimes(1);
  });

  it("always reads the latest run closure without re-registering", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderWithShell(<Harness bindings={[binding({ id: "t.j", keys: "j", run: first })]} />);
    rerender(<Harness bindings={[binding({ id: "t.j", keys: "j", run: second })]} />);
    press(document.body, "j");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("unregisters when the component unmounts", () => {
    const run = vi.fn();
    const { unmount } = renderWithShell(<Harness bindings={[binding({ id: "t.j", keys: "j", run })]} />);
    unmount();
    press(document.body, "j");
    expect(run).not.toHaveBeenCalled();
  });

  it("is a safe no-op without a provider", () => {
    const run = vi.fn();
    render(<Harness bindings={[binding({ id: "t.j", keys: "j", run })]} />);
    press(document.body, "j");
    expect(run).not.toHaveBeenCalled();
  });

  describe("chords", () => {
    it("fires on the second key and shows the pending buffer in between", () => {
      const run = vi.fn();
      renderWithShell(<Harness bindings={[binding({ id: "t.top", keys: "g g", run })]} />);
      expect(press(document.body, "g")).toBe(false);
      expect(run).not.toHaveBeenCalled();
      expect(screen.getByLabelText("chord").textContent).toBe("g");
      press(document.body, "g");
      expect(run).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("chord").textContent).toBe("");
    });

    it("drops the buffer after 800ms", () => {
      vi.useFakeTimers();
      const run = vi.fn();
      renderWithShell(<Harness bindings={[binding({ id: "t.top", keys: "g g", run })]} />);
      press(document.body, "g");
      act(() => {
        vi.advanceTimersByTime(801);
      });
      expect(screen.getByLabelText("chord").textContent).toBe("");
      press(document.body, "g");
      expect(run).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      press(document.body, "g");
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("lets a broken chord's key start over (g then j still runs j)", () => {
      const down = vi.fn();
      renderWithShell(
        <Harness bindings={[binding({ id: "t.top", keys: "g g", run: () => {} }), binding({ id: "t.j", keys: "j", run: down })]} />,
      );
      press(document.body, "g");
      press(document.body, "j");
      expect(down).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("chord").textContent).toBe("");
    });

    it("ignores bare modifier keys inside a chord", () => {
      const run = vi.fn();
      renderWithShell(<Harness bindings={[binding({ id: "t.top", keys: "g g", run })]} />);
      press(document.body, "g");
      press(document.body, "Shift", { shiftKey: true });
      press(document.body, "g");
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  describe("StrictMode", () => {
    it("registers each binding once and fires once per key", () => {
      const run = vi.fn();
      function Count() {
        const entries = useKeymapEntries();
        return <output aria-label="count">{entries.filter(entry => entry.binding.id === "t.j").length}</output>;
      }
      renderWithShell(
        <>
          <Harness bindings={[binding({ id: "t.j", keys: "j", run })]} />
          <Count />
        </>,
        { strict: true },
      );
      expect(screen.getByLabelText("count").textContent).toBe("1");
      press(document.body, "j");
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("keeps exactly one live window keydown listener after the double mount", () => {
      const add = vi.spyOn(window, "addEventListener");
      const remove = vi.spyOn(window, "removeEventListener");
      const count = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === "keydown").length;
      renderWithShell(<Harness bindings={[]} />, { strict: true });
      expect(count(add) - count(remove)).toBe(1);
      cleanup();
      expect(count(add) - count(remove)).toBe(0);
      add.mockRestore();
      remove.mockRestore();
    });
  });
});
