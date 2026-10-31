import { useEffect, useState } from "react";

/** Below this window width the inspector goes under the map (`_flow.scss`); the map then keeps its compact height. */
const STACKED = "(max-width: 900px)";

/**
 * The height the flow map may grow into: the page's visible height less what sits above the map (the header) and
 * below it (the cells under the map, the margins and the page's padding). It is measured from the page and the
 * elements around the map, never from the map or the inspector, so the map growing into it cannot change it and
 * selecting something with a long inspector does not make the map jump. 0 while it is not measured (a test renderer
 * without ResizeObserver) and while the inspector sits under the map. The refs are callbacks, so the measuring starts
 * again when the page comes back (the install review replaces it while it is open).
 */
export function useFlowRoom(): { room: number; pageRef: (element: HTMLElement | null) => void; flowRef: (element: HTMLElement | null) => void } {
  const [room, setRoom] = useState(0);
  const [page, pageRef] = useState<HTMLElement | null>(null);
  const [flow, flowRef] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!page || !flow || typeof ResizeObserver === "undefined") return;
    const read = () => setRoom(measureRoom(page, flow));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(page);
    for (const child of page.children) if (child !== flow) observer.observe(child);
    return () => observer.disconnect();
  }, [page, flow]);
  return { room, pageRef, flowRef };
}

function measureRoom(page: HTMLElement, flow: HTMLElement): number {
  if (window.matchMedia?.(STACKED).matches) return 0;
  const pageStyle = getComputedStyle(page);
  // From the top of the page's scrolled content to the top of the map's row: the padding, the header and the margins.
  const above = flow.getBoundingClientRect().top - page.getBoundingClientRect().top - page.clientTop + page.scrollTop;
  let below = parseFloat(getComputedStyle(flow).marginBottom) + parseFloat(pageStyle.paddingBottom);
  for (let next = flow.nextElementSibling; next; next = next.nextElementSibling) below += next.getBoundingClientRect().height;
  return Math.max(0, Math.floor(page.clientHeight - above - below));
}
