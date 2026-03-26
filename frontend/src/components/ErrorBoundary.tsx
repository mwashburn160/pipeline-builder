import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

/** Props for the ErrorBoundary component. */
interface Props {
  /** Child components to render when no error is present */
  children: ReactNode;
  /** Custom UI to display instead of the default error screen */
  fallback?: ReactNode;
  /** Callback invoked when an error is caught, useful for error reporting */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

/** Internal state for the ErrorBoundary. */
interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * React error boundary that catches rendering errors in its subtree.
 * Displays a default error screen with a retry button, or a custom fallback if provided.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error);
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-[400px] flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <div className="mb-4">
              <AlertTriangle className="mx-auto h-12 w-12 text-red-500 dark:text-red-400" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Something went wrong
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              An unexpected error occurred. Please try again.
            </p>
            <button
              onClick={this.handleRetry}
              className="btn btn-primary"
            >
              Try again
            </button>
            {this.state.error && process.env.NODE_ENV !== 'production' && (
              <details className="mt-4 text-left text-sm text-gray-500 dark:text-gray-400">
                <summary className="cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
                  Error details
                </summary>
                <pre className="mt-2 overflow-auto rounded bg-gray-100 p-2 dark:bg-gray-800 text-xs">
                  {this.state.error.message}
                  {'\n'}
                  {this.state.error.stack}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
