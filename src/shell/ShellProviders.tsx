import type { ReactNode } from "react";
import { KeymapProvider } from "../keyboard/KeymapProvider";
import type { Platform } from "../keyboard/keymap";
import { ShellStateProvider } from "./ShellState";

interface ShellProvidersProps {
  children: ReactNode;
  /** Override platform detection (tests). */
  platform?: Platform;
  chordTimeoutMs?: number;
}

/** Keymap + command registries and shell state (overlays, mode, notices). Mount once above the app shell. */
export function ShellProviders({ children, platform, chordTimeoutMs }: ShellProvidersProps) {
  return (
    <KeymapProvider platform={platform} chordTimeoutMs={chordTimeoutMs}>
      <ShellStateProvider>{children}</ShellStateProvider>
    </KeymapProvider>
  );
}
