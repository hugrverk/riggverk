import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import App from "./App";
import { framePlatform } from "./platform";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/index.scss";

async function bootstrap() {
  document.documentElement.dataset.frame = framePlatform(isTauri(), navigator.userAgent);

  // Browser-only visual QA: `vite dev` + `?mock=<scenario>` swaps in src/dev/mockBackend.
  // The branch is dead code in production builds (import.meta.env.DEV is false), so dist
  // never contains the mock.
  if (import.meta.env.DEV && !isTauri() && new URLSearchParams(location.search).has("mock")) {
    await import("./dev/mockBackend");
  }

  if (isTauri()) {
    document.documentElement.dataset.tauri = "";
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
