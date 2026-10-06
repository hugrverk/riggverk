import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/index.scss";

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
