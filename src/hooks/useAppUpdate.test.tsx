import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../lib/settingsDraft";
import type { AppSettings, AppUpdateCheck } from "../types";
import { DAILY_INTERVAL_SECS, dailyCheckDue, useAppUpdate } from "./useAppUpdate";

const invokeMock = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  },
}));

const AVAILABLE: AppUpdateCheck = {
  status: "available",
  version: "2026.11.7",
  current_version: "2026.11.6",
  notes: "## New\n\n- A thing",
  date: null,
  app_path: "/Applications/Riggverk.app",
  blocked: null,
};

function backend({ configured, check = AVAILABLE }: { configured: boolean; check?: AppUpdateCheck }) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "get_app_update_info") return { configured, current_version: "2026.11.6" };
    if (cmd === "check_app_update") return check;
    if (cmd === "install_app_update") return undefined;
    throw new Error(`unexpected ${cmd}`);
  });
}

const calls = (cmd: string) => invokeMock.mock.calls.filter(([name]) => name === cmd);

function setup(settings: AppSettings | null, beforeRestart = vi.fn(async () => true), installBlocked: string | false = false) {
  const setUpdateCheck = vi.fn();
  const setLastUpdateCheck = vi.fn();
  const view = renderHook(
    ({ current }) => useAppUpdate({ settings: current, setUpdateCheck, setLastUpdateCheck, beforeRestart, installBlocked }),
    { initialProps: { current: settings } },
  );
  return { ...view, setUpdateCheck, setLastUpdateCheck, beforeRestart };
}

const settle = () => act(async () => {});

beforeEach(() => {
  invokeMock.mockReset();
  listeners.clear();
});

describe("useAppUpdate", () => {
  it("shows nothing and checks nothing while the build has updates off", async () => {
    backend({ configured: false });
    const { result } = setup({ ...defaultSettings(), update_check: "daily", last_update_check: null });
    await settle();
    expect(result.current.configured).toBe(false);
    expect(result.current.consentNeeded).toBe(false);
    expect(calls("check_app_update")).toHaveLength(0);
    expect(listeners.size).toBe(0);
  });

  it("asks first and makes no check before the user chooses", async () => {
    backend({ configured: true });
    const { result, setUpdateCheck } = setup({ ...defaultSettings() });
    await settle();
    expect(result.current.consentNeeded).toBe(true);
    expect(calls("check_app_update")).toHaveLength(0);

    act(() => result.current.notNow());
    expect(setUpdateCheck).toHaveBeenCalledWith("manual");
    expect(calls("check_app_update")).toHaveLength(0);
  });

  it("checks right away after Check daily and names the new version without opening the review", async () => {
    backend({ configured: true });
    const { result, setUpdateCheck, setLastUpdateCheck } = setup({ ...defaultSettings() });
    await settle();
    await act(async () => result.current.chooseDaily());
    expect(setUpdateCheck).toHaveBeenCalledWith("daily");
    expect(calls("check_app_update")).toEqual([["check_app_update", { automatic: false }]]);
    expect(setLastUpdateCheck).toHaveBeenCalledTimes(1);
    expect(result.current.available?.version).toBe("2026.11.7");
    expect(result.current.review).toBeNull();
  });

  it("runs the daily check once per launch, only when it is due", async () => {
    backend({ configured: true });
    const now = Math.floor(Date.now() / 1000);
    const recent = setup({ ...defaultSettings(), update_check: "daily", last_update_check: now - 60 });
    await settle();
    expect(calls("check_app_update")).toHaveLength(0);
    recent.unmount();

    const due = setup({ ...defaultSettings(), update_check: "daily", last_update_check: now - DAILY_INTERVAL_SECS });
    await settle();
    due.rerender({ current: { ...defaultSettings(), update_check: "daily", last_update_check: now } });
    await settle();
    expect(calls("check_app_update")).toEqual([["check_app_update", { automatic: true }]]);
  });

  it("answers a check from the menu in the review, also when there is nothing new", async () => {
    backend({ configured: true, check: { status: "up_to_date", current_version: "2026.11.6" } });
    const { result } = setup({ ...defaultSettings(), update_check: "manual" });
    await settle();
    await act(async () => listeners.get("app-update-check-requested")?.({ payload: null }));
    expect(result.current.review).toEqual({ kind: "up_to_date", version: "2026.11.6" });
  });

  it("installs the reviewed version only after unsaved work is settled", async () => {
    backend({ configured: true });
    const beforeRestart = vi.fn(async () => false);
    const { result } = setup({ ...defaultSettings(), update_check: "manual" }, beforeRestart);
    await settle();
    await act(async () => result.current.checkNow());
    expect(result.current.review?.kind).toBe("available");

    await act(async () => result.current.install());
    expect(beforeRestart).toHaveBeenCalledTimes(1);
    expect(calls("install_app_update")).toHaveLength(0);

    beforeRestart.mockResolvedValue(true);
    await act(async () => result.current.install());
    expect(calls("install_app_update")).toEqual([["install_app_update", { version: "2026.11.7" }]]);
  });

  it("does not start an install while an apply runs", async () => {
    backend({ configured: true });
    const beforeRestart = vi.fn(async () => true);
    const { result } = setup({ ...defaultSettings(), update_check: "manual" }, beforeRestart, "applying");
    await settle();
    await act(async () => result.current.checkNow());
    await act(async () => result.current.install());
    expect(beforeRestart).not.toHaveBeenCalled();
    expect(calls("install_app_update")).toHaveLength(0);
  });
});

describe("dailyCheckDue", () => {
  it("is due only for the daily choice once a day has passed", () => {
    const now = 100 * DAILY_INTERVAL_SECS;
    expect(dailyCheckDue({ update_check: "daily", last_update_check: null }, now)).toBe(true);
    expect(dailyCheckDue({ update_check: "daily", last_update_check: now - 10 }, now)).toBe(false);
    expect(dailyCheckDue({ update_check: "daily", last_update_check: now + 10 }, now)).toBe(true);
    expect(dailyCheckDue({ update_check: "ask", last_update_check: null }, now)).toBe(false);
    expect(dailyCheckDue({ update_check: "manual", last_update_check: null }, now)).toBe(false);
  });
});
