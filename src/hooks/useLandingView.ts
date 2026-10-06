import { useEffect, useRef } from "react";
import type { AppView } from "../shell/views";

const LANDING_VIEWS: readonly string[] = ["repo-dashboard", "prompts", "library"];

interface LandingViewOptions {
  /** Persisted `landing_view`; undefined until settings have loaded. */
  landingView: string | undefined;
  currentView: AppView;
  /** Navigation entry point that runs dirty guards and per-view data loading. */
  navigate: (view: AppView) => void;
}

/**
 * Opens the configured landing page once, when settings first load.
 * Later changes to the setting (e.g. in Settings) never navigate, and a user
 * who already left the initial view is not pulled away.
 */
export function useLandingView({ landingView, currentView, navigate }: LandingViewOptions): void {
  const appliedRef = useRef(false);
  const currentViewRef = useRef(currentView);
  currentViewRef.current = currentView;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    if (appliedRef.current || landingView === undefined) return;
    appliedRef.current = true;
    if (currentViewRef.current !== "start") return;
    if (LANDING_VIEWS.includes(landingView)) navigateRef.current(landingView as AppView);
  }, [landingView]);
}
