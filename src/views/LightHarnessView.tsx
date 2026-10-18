import type { LightAgent, LightRuntimeHealth } from "../types";
import { HarnessPage } from "./HarnessPage";
import type { HarnessViewProps } from "./pageTypes";

/** Copilot, Pi and Kilo: one page for the light tier, which differs only in its name and its runtime health. */
export function LightHarnessView({
  harness,
  runtimeHealth,
  ...props
}: HarnessViewProps & { harness: LightAgent; runtimeHealth: LightRuntimeHealth | null }) {
  return (
    <HarnessPage
      {...props}
      harness={harness}
      runtime={{ harness, health: runtimeHealth }}
    />
  );
}
