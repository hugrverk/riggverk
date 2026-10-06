import { StrictMode, type ReactElement, type ReactNode } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { Platform } from "../keyboard/keymap";
import { AppFrame, type AppFrameProps } from "../shell/AppFrame";
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
    <ShellProviders platform={platform} chordTimeoutMs={chordTimeoutMs}>
      {node}
    </ShellProviders>
  );
  const wrap = (node: ReactNode) => (strict ? <StrictMode>{tree(node)}</StrictMode> : tree(node));
  const result = render(wrap(ui), options);
  return {
    ...result,
    rerender: next => result.rerender(wrap(next)),
  };
}

export type FrameProps = Partial<Omit<AppFrameProps, "children">>;

/** The app's frame with sensible defaults, for tests that need top line, status bar and overlays. */
export function TestFrame({ children, ...props }: FrameProps & { children?: ReactNode }) {
  return (
    <AppFrame
      view="start"
      onSwitchView={() => {}}
      libraryDirty={false}
      settingsErrored={false}
      error={null}
      onDismissError={() => {}}
      {...props}
    >
      {children}
    </AppFrame>
  );
}

/** `renderWithShell` plus the frame around `children`. */
export function renderInFrame(
  children: ReactNode,
  props: FrameProps = {},
  options: RenderWithShellOptions = {},
): RenderResult & { rerenderFrame: (children: ReactNode, props?: FrameProps) => void } {
  const result = renderWithShell(<TestFrame {...props}>{children}</TestFrame>, options);
  return {
    ...result,
    rerenderFrame: (next, nextProps = props) => result.rerender(<TestFrame {...nextProps}>{next}</TestFrame>),
  };
}
