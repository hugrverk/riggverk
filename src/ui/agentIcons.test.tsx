import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALL_AGENTS } from "../types";
import { AgentGlyph, AgentIcon, AGENT_BADGE_LABEL, type AgentBadgeState } from "./agentIcons";

afterEach(cleanup);

const STATES: AgentBadgeState[] = ["ok", "ready", "decide", "yours", "fix", "off", "missing"];

describe("AgentIcon", () => {
  it("draws one monochrome 24 x 24 glyph for every agent, from path data only", () => {
    const shapes = new Set<string>();
    for (const harness of INSTALL_AGENTS) {
      const { container, unmount } = render(<AgentIcon harness={harness} />);
      const svg = container.querySelector("svg.agent-glyph")!;
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      const paths = [...svg.querySelectorAll("path")];
      expect(paths.length, harness).toBeGreaterThan(0);
      // Nothing but paths, filled even-odd; the colour comes from CSS (currentColor), never from the shapes.
      expect(svg.children.length).toBe(paths.length);
      for (const path of paths) {
        expect(path.getAttribute("fill-rule")).toBe("evenodd");
        expect(path.getAttribute("fill")).toBeNull();
        expect(path.getAttribute("style")).toBeNull();
      }
      shapes.add(paths.map(path => path.getAttribute("d")).join("|"));
      unmount();
    }
    // Seven agents, seven different glyphs.
    expect(shapes.size).toBe(INSTALL_AGENTS.length);
  });

  it("is named after the agent and its state in words, and has no badge without a state", () => {
    const { container } = render(<AgentIcon harness="claude" />);
    expect(screen.getByRole("img", { name: "Claude" })).toBeTruthy();
    expect(container.querySelector(".agent-badge")).toBeNull();
  });

  it.each(STATES)("shows the %s state as a badge on the icon and says it in the name", state => {
    const { container } = render(<AgentIcon harness="opencode" state={state} />);
    const icon = screen.getByRole("img", { name: `OpenCode, ${AGENT_BADGE_LABEL[state]}` });
    const badge = container.querySelector(".agent-badge")!;
    expect(icon.contains(badge)).toBe(true);
    expect(badge.classList.contains(`is-${state}`)).toBe(true);
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    // Off and missing agents are muted; the others keep the ink.
    expect(icon.classList.contains("is-dim")).toBe(state === "off" || state === "missing");
  });

  it("says the decision in words and gives it its own badge", () => {
    render(<AgentIcon harness="cursor" state="decide" />);
    expect(screen.getByRole("img", { name: "Cursor, Needs your decision" })).toBeTruthy();
  });

  it("can be decorative when the name and the state stand beside it, or carry its own name", () => {
    const { container, rerender } = render(<AgentIcon harness="pi" state="ok" decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector(".agent-icon")!.getAttribute("aria-hidden")).toBe("true");
    rerender(<AgentIcon harness="pi" state="ok" label="Pi is up to date" />);
    expect(screen.getByRole("img", { name: "Pi is up to date" })).toBeTruthy();
  });

  it("sizes the box and the glyph in pixels", () => {
    const { container } = render(<AgentIcon harness="codex" size={20} />);
    const icon = container.querySelector<HTMLElement>(".agent-icon")!;
    expect(icon.style.width).toBe("20px");
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("20");
  });
});

describe("AgentGlyph", () => {
  it("nests in an SVG at a position, decorative and filled by currentColor", () => {
    const { container } = render(
      <svg>
        <AgentGlyph harness="claude" x={4} y={10} />
      </svg>,
    );
    const glyph = container.querySelector("svg.agent-glyph")!;
    expect(glyph.getAttribute("x")).toBe("4");
    expect(glyph.getAttribute("y")).toBe("10");
    expect(glyph.getAttribute("width")).toBe("16");
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
  });
});
