import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, AppUpdateCheck, AppUpdateInfo, AppUpdateProgress, AvailableUpdate, UpdateCheckChoice } from "../types";

/** The backend's events (`app_update::UPDATE_PROGRESS_EVENT`, `app_update::UPDATE_MENU_EVENT`). */
export const UPDATE_PROGRESS_EVENT = "app-update-progress";
export const UPDATE_MENU_EVENT = "app-update-check-requested";

/** A daily check runs when the last successful one is at least this old (`app_update::DAILY_INTERVAL_SECS`). */
export const DAILY_INTERVAL_SECS = 24 * 60 * 60;

const nowSecs = () => Math.floor(Date.now() / 1000);

/** The backend rejects with its message as a string; anything else is shown by its message. */
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether the daily check is due: the user chose it and a day has passed (or the clock went back). */
export function dailyCheckDue(settings: Pick<AppSettings, "update_check" | "last_update_check">, now = nowSecs()): boolean {
  if (settings.update_check !== "daily") return false;
  const last = settings.last_update_check;
  return last == null || last > now || now - last >= DAILY_INTERVAL_SECS;
}

/** What the review overlay shows. */
export type UpdateReview =
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "up_to_date"; version: string }
  | { kind: "error"; message: string };

interface AppUpdateOptions {
  /** The loaded settings; null until they are. */
  settings: AppSettings | null;
  setUpdateCheck: (choice: UpdateCheckChoice) => void;
  setLastUpdateCheck: (seconds: number) => void;
  /** Settles unsaved work like the close guard does (Library drafts, a pending settings change); false: stay. */
  beforeRestart: () => Promise<boolean>;
  /** Why an install cannot start now (an apply is running), or false. */
  installBlocked: string | false;
}

export interface AppUpdate {
  /** This build has updates on. False: the UI shows nothing and the app asks nothing over the network. */
  configured: boolean;
  /** The user has not chosen yet: the consent card shows. */
  consentNeeded: boolean;
  /** A newer version a check found; the sidebar foot names it. */
  available: AvailableUpdate | null;
  review: UpdateReview | null;
  checking: boolean;
  progress: AppUpdateProgress | null;
  installing: boolean;
  installError: string | null;
  installBlocked: string | false;
  chooseDaily: () => void;
  notNow: () => void;
  setChoice: (choice: UpdateCheckChoice) => void;
  checkNow: () => void;
  openReview: () => void;
  closeReview: () => void;
  install: () => void;
}

/**
 * The consent-first app update. Nothing reaches the network before the user chose: the sidebar card asks once
 * ("Check daily" or "Not now"). With "daily" one check runs at startup when a day has passed; "Check for Updates…"
 * (menu, Settings) checks on request and always shows the answer. A new version is only named in the sidebar foot;
 * its review shows the notes, and "Download and restart" first settles unsaved work like closing the window does,
 * then installs exactly the reviewed version. Without updates in the build (`configured` false) it does nothing.
 */
export function useAppUpdate({ settings, setUpdateCheck, setLastUpdateCheck, beforeRestart, installBlocked }: AppUpdateOptions): AppUpdate {
  const [configured, setConfigured] = useState(false);
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [review, setReview] = useState<UpdateReview | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const checkedThisLaunch = useRef(false);
  const latest = useRef({ setLastUpdateCheck, beforeRestart });
  latest.current = { setLastUpdateCheck, beforeRestart };

  useEffect(() => {
    let disposed = false;
    invoke<AppUpdateInfo>("get_app_update_info")
      .then(info => {
        if (!disposed) setConfigured(info.configured);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  const runCheck = useCallback(async (automatic: boolean, show: boolean) => {
    checkedThisLaunch.current = true;
    setChecking(true);
    try {
      const result = await invoke<AppUpdateCheck>("check_app_update", { automatic });
      if (result.status === "skipped") return;
      latest.current.setLastUpdateCheck(nowSecs());
      if (result.status === "available") {
        setAvailable(result);
        if (show) setReview({ kind: "available", update: result });
      } else {
        setAvailable(null);
        if (show) setReview({ kind: "up_to_date", version: result.current_version });
      }
    } catch (error) {
      // An automatic check fails quietly (offline is normal); one the user asked for says so.
      if (show) setReview({ kind: "error", message: errorText(error) });
    } finally {
      setChecking(false);
    }
  }, []);

  const checkNow = useCallback(() => {
    if (configured) void runCheck(false, true);
  }, [configured, runCheck]);

  // The daily check, once per launch, when it is due.
  useEffect(() => {
    if (!configured || !settings || checkedThisLaunch.current) return;
    if (dailyCheckDue(settings)) void runCheck(true, false);
  }, [configured, settings, runCheck]);

  // "Check for Updates…" in the app menu.
  useEffect(() => {
    if (!configured) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen(UPDATE_MENU_EVENT, () => checkNow())
      .then(stop => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [configured, checkNow]);

  useEffect(() => {
    if (!configured) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<AppUpdateProgress>(UPDATE_PROGRESS_EVENT, event => {
      if (!disposed) setProgress(event.payload);
    })
      .then(stop => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [configured]);

  const chooseDaily = useCallback(() => {
    setUpdateCheck("daily");
    // The user just agreed: check now. The saved choice may still be on its way to disk, so this is not the
    // automatic check (which reads the saved settings).
    void runCheck(false, false);
  }, [setUpdateCheck, runCheck]);

  const install = useCallback(() => {
    if (review?.kind !== "available" || installing || installBlocked || review.update.blocked) return;
    const version = review.update.version;
    void (async () => {
      setInstallError(null);
      if (!(await latest.current.beforeRestart())) return;
      setInstalling(true);
      setProgress(null);
      try {
        // On success the app restarts and this never resolves into a visible state.
        await invoke("install_app_update", { version });
      } catch (error) {
        setInstallError(errorText(error));
      } finally {
        setInstalling(false);
      }
    })();
  }, [review, installing, installBlocked]);

  const choice = settings?.update_check ?? "ask";
  return {
    configured,
    consentNeeded: configured && settings !== null && choice === "ask",
    available: configured ? available : null,
    review: configured ? review : null,
    checking,
    progress: installing ? progress : null,
    installing,
    installError,
    installBlocked,
    chooseDaily,
    notNow: () => setUpdateCheck("manual"),
    setChoice: setUpdateCheck,
    checkNow,
    openReview: () => {
      if (available) setReview({ kind: "available", update: available });
    },
    closeReview: () => {
      if (installing) return;
      setReview(null);
      setInstallError(null);
    },
    install,
  };
}
