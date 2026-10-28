import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StateMark, StatePill } from "./StatePill";

afterEach(cleanup);

describe("StatePill", () => {
  it("says the state in words, with a decorative marker", () => {
    const { container } = render(<StatePill state="decide">1 to decide</StatePill>);
    const pill = screen.getByText("1 to decide");
    expect(pill.classList.contains("state-pill")).toBe(true);
    expect(pill.classList.contains("is-decide")).toBe(true);
    const mark = container.querySelector(".state-mark")!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.textContent).toBe("");
  });

  it("gives every state its own class and a quiet one to findings", () => {
    const states = ["ok", "ready", "decide", "yours", "fix", "off", "tip"] as const;
    const { container } = render(
      <>
        {states.map(state => (
          <StatePill key={state} state={state}>
            {state}
          </StatePill>
        ))}
      </>,
    );
    expect([...container.querySelectorAll(".state-pill")].map(pill => pill.className)).toEqual(
      states.map(state => `state-pill is-${state}`),
    );
  });

  it("can stand alone as a marker, still hidden from assistive technology", () => {
    const { container } = render(<StateMark state="ok" />);
    expect(container.querySelector("i.state-mark.is-ok")!.getAttribute("aria-hidden")).toBe("true");
  });
});
