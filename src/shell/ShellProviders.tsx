import type { ReactNode } from "react";
import { ConfirmProvider } from "../components/ConfirmDialog";
import { KeymapProvider } from "../keyboard/KeymapProvider";
import type { Platform } from "../keyboard/keymap";
import { ShellStateProvider } from "./ShellState";

interface ShellProvidersProps {
  children: ReactNode;
  /** Override platform detection (tests). */
  platform?: Platform;
  chordTimeoutMs?: number;
}

/**
 * Keymap + command registries, shell state (overlays, notices) and the confirm dialog. Mount once above the app shell.
 */
export function ShellProviders({ children, platform, chordTimeoutMs }: ShellProvidersProps) {
  return (
    <KeymapProvider platform={platform} chordTimeoutMs={chordTimeoutMs}>
      <ShellStateProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ShellStateProvider>
    </KeymapProvider>
  );
}
