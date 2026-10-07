import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MatrixRowModel } from "../lib/installationView";
import { SurfaceMatrix } from "./SurfaceMatrix";

afterEach(cleanup);

const ROWS: MatrixRowModel[] = [
  {
    id: "workspace",
    label: "workspace",
    cells: [
      { column: "config", state: "na", display: { glyph: "none", tone: "dim", label: "n/a" } },
      { column: "agents", state: "na", display: { glyph: "none", tone: "dim", label: "n/a" } },
      { column: "rules", state: "na", display: { glyph: "none", tone: "dim", label: "n/a" } },
      { column: "skills", state: "na", display: { glyph: "none", tone: "dim", label: "n/a" } },
      { column: "mcp", state: "na", display: { glyph: "none", tone: "dim", label: "n/a" } },
      { column: "bundle", state: "current", display: { glyph: "ok", tone: "ok", label: "current" } },
    ],
  },
  {
    id: "cursor",
    label: "cursor",
    cells: [
      { column: "config", state: "na", display: { glyph: "none", tone: "dim", label: "n/a" } },
      { column: "agents", state: "off", display: { glyph: "none", tone: "dim", label: "off" } },
      { column: "rules", state: "na", display: { glyph: "none", tone: "dim", label: "n/a" } },
      { column: "skills", state: "update_available", display: { glyph: "partial", tone: "warn", label: "update" } },
      { column: "mcp", state: "conflict", display: { glyph: "fail", tone: "fail", label: "conflict" } },
      { column: "bundle", state: "na", display: { glyph: "none", tone: "dim", label: "n/a" } },
    ],
  },
];

describe("SurfaceMatrix", () => {
  it("is a CSS-grid table with one column per surface kind", () => {
    render(<SurfaceMatrix rows={ROWS} />);
    const table = screen.getByRole("table", { name: "Installed surfaces" });
    expect(table.classList.contains("matrix-grid")).toBe(true);
    expect(table.style.getPropertyValue("--matrix-cols")).toBe("6");
    expect(within(table).getAllByRole("columnheader").map(header => header.textContent)).toEqual([
      "target",
      "config",
      "agents",
      "rules",
      "skills",
      "mcp",
      "bundle",
    ]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });

  it("gives every cell a glyph and a text label, never colour alone", () => {
    render(<SurfaceMatrix rows={ROWS} />);
    const cursor = screen.getByRole("rowheader", { name: "cursor" }).parentElement!;
    const cells = within(cursor).getAllByRole("cell");
    expect(cells.map(cell => cell.querySelector(".g")!.textContent)).toEqual(["·", "·", "·", "◐", "✗", "·"]);
    expect(cells.map(cell => cell.querySelector(".visually-hidden")!.textContent)).toEqual([
      "n/a",
      "off",
      "n/a",
      "update",
      "conflict",
      "n/a",
    ]);
    // The glyph is decoration, the visually hidden word is the accessible name of the state.
    expect(cells[4]!.querySelector(".g")!.getAttribute("aria-hidden")).toBe("true");
    expect(cells[4]!.getAttribute("title")).toBe("cursor mcp: conflict");
  });

  it("has no legend row (it lives in the help overlay) and emphasises the selected row", () => {
    const { container } = render(<SurfaceMatrix rows={ROWS} selectedId="cursor" />);
    expect(screen.queryByLabelText("Legend")).toBeNull();
    expect(container.querySelector(".matrix-legend")).toBeNull();
    expect(container.children).toHaveLength(1);
    expect(screen.getByRole("rowheader", { name: "cursor" }).classList.contains("c-head")).toBe(true);
    expect(screen.getByRole("rowheader", { name: "workspace" }).classList.contains("c-head")).toBe(false);
  });
});
