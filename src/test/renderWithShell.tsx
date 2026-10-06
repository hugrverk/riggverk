import { StrictMode, type ReactElement, type ReactNode } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { ConfirmProvider } from "../components/ConfirmDialog";
import type { Platform } from "../keyboard/keymap";
import { ShellProviders } from "../shell/ShellProviders";

export interface RenderWithShellOptions extends Omit<RenderOptions, "wrapper"> {
  /** Wrap in React.StrictMode (double-mounts effects) to prove registration is idempotent. */
  strict?: boolean;
  /** Platform for Mod+key matching; defaults to "other" (Ctrl) so tests do not depend on the host. */
  platform?: Platform;
  chordTimeoutMs?: number;
}

/**
 * Renders under the same providers as the app: confirm dialog, keymap and command registries, shell
 * state. The single window keydown listener is installed, so `fireEvent.keyDown(...)` behaves like a
 * real key press.
 */
export function renderWithShell(
  ui: ReactElement,
  { strict = false, platform = "other", chordTimeoutMs, ...options }: RenderWithShellOptions = {},
): RenderResult {
  const tree = (node: ReactNode) => (
    <ConfirmProvider>
      <ShellProviders platform={platform} chordTimeoutMs={chordTimeoutMs}>
        {node}
      </ShellProviders>
    </ConfirmProvider>
  );
  const wrap = (node: ReactNode) => (strict ? <StrictMode>{tree(node)}</StrictMode> : tree(node));
  const result = render(wrap(ui), options);
  return {
    ...result,
    rerender: next => result.rerender(wrap(next)),
  };
}
