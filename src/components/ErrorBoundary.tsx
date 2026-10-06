import { Component, type ErrorInfo, type ReactNode } from "react";
import { Glyph } from "../ui/Glyph";
import { Pane } from "../ui/Pane";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Top-level safety net: a render error shows a recoverable message instead of a blank window. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled UI error", error, info.componentStack);
  }

  private retry = () => {
    this.setState({ error: null });
  };

  private reload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-screen" role="alert">
        <Pane
          id="error-boundary"
          title="error"
          label="Application error"
          meta="· render failed"
          footer={
            <>
              <button type="button" className="btn btn-sm btn-primary" autoFocus onClick={this.retry}>
                try again
              </button>
              <button type="button" className="btn btn-sm" onClick={this.reload}>
                reload
              </button>
            </>
          }
        >
          <p className="error-message">
            <Glyph name="fail" tone="fail" />
            <span>Something went wrong: {error.message}</span>
          </p>
          <p className="error-hint">try again re-renders the view; reload restarts the window. Edits that were not saved are lost.</p>
        </Pane>
      </div>
    );
  }
}
