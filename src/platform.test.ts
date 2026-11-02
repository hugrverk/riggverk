import { expect, it } from "vitest";
import { framePlatform } from "./platform";

it("reserves the overlay frame only for macOS and browser previews", () => {
  expect(framePlatform(true, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
  expect(framePlatform(true, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("native");
  expect(framePlatform(true, "Mozilla/5.0 (X11; Linux x86_64)")).toBe("native");
  expect(framePlatform(false, "Linux")).toBe("macos");
});
