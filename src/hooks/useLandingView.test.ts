import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppView } from "../shell/views";
import { useLandingView } from "./useLandingView";

type Props = { landingView: string | undefined; currentView: AppView };

function setup(initial: Props) {
  const navigate = vi.fn();
  const hook = renderHook((props: Props) => useLandingView({ ...props, navigate }), { initialProps: initial });
  return { navigate, ...hook };
}

describe("useLandingView", () => {
  it("does not navigate before settings have loaded", () => {
    const { navigate } = setup({ landingView: undefined, currentView: "start" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigates once to the configured landing view when settings first load", () => {
    const { navigate, rerender } = setup({ landingView: undefined, currentView: "start" });
    rerender({ landingView: "library", currentView: "start" });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("library");
  });

  it("stays on start when the landing view is start", () => {
    const { navigate, rerender } = setup({ landingView: undefined, currentView: "start" });
    rerender({ landingView: "start", currentView: "start" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not navigate away from Settings when the landing page setting changes", () => {
    const { navigate, rerender } = setup({ landingView: undefined, currentView: "start" });
    rerender({ landingView: "start", currentView: "start" });
    rerender({ landingView: "start", currentView: "settings" });
    rerender({ landingView: "library", currentView: "settings" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not pull a user away if they already left the initial view", () => {
    const { navigate, rerender } = setup({ landingView: undefined, currentView: "settings" });
    rerender({ landingView: "library", currentView: "settings" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("ignores unknown landing values", () => {
    const { navigate, rerender } = setup({ landingView: undefined, currentView: "start" });
    rerender({ landingView: "bogus", currentView: "start" });
    expect(navigate).not.toHaveBeenCalled();
  });
});
