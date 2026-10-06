import { Component, type ErrorInfo, type ReactNode } from "react";

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
      <div className="error-banner" role="alert">
        <span className="error-banner-text">Something went wrong: {error.message}</span>
        <button type="button" className="btn btn-sm" onClick={this.retry}>
          try again
        </button>
        <button type="button" className="btn btn-sm" onClick={this.reload}>
          reload
        </button>
      </div>
    );
  }
}
