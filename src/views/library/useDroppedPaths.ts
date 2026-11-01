import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * While `enabled`, calls `onDrop` with the paths of files and folders dropped onto the app window, and `onHover`
 * while something is dragged over it. Tauri hands the webview the paths (no file content); the app's capability
 * already allows the event listener this needs (`core:event:allow-listen`). Outside the app (the browser preview,
 * tests) there is no window to listen to, and nothing happens.
 */
export function useDroppedPaths(enabled: boolean, onDrop: (paths: string[]) => void, onHover: (over: boolean) => void): void {
  const dropRef = useRef(onDrop);
  const hoverRef = useRef(onHover);
  dropRef.current = onDrop;
  hoverRef.current = onHover;

  useEffect(() => {
    if (!enabled) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    const listen = async () => {
      try {
        const unlisten = await getCurrentWebview().onDragDropEvent(event => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            hoverRef.current(true);
          } else if (payload.type === "leave") {
            hoverRef.current(false);
          } else {
            hoverRef.current(false);
            if (payload.paths.length > 0) dropRef.current(payload.paths);
          }
        });
        if (cancelled) unlisten();
        else stop = unlisten;
      } catch {
        // Not in the app window: no drops.
      }
    };
    void listen();
    return () => {
      cancelled = true;
      stop?.();
      hoverRef.current(false);
    };
  }, [enabled]);
}
