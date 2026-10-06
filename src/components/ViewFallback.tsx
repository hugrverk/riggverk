/**
 * Suspense fallback for lazily loaded views: the pane chrome (title notch, body) without `data-pane-id`, so
 * the view-switch focus wait in `useViewFocus` keeps waiting for the real view's first pane instead of
 * landing on this placeholder.
 */
export function ViewFallback({ title }: { title: string }) {
  return (
    <section className="screen" aria-label={`${title}, loading`} aria-busy="true">
      <div className="pane">
        <span className="pane-title"><b>{title}</b></span>
        <div className="pane-body">
          <p className="view-fallback-note c-dim" role="status">loading…</p>
        </div>
      </div>
    </section>
  );
}
