/** Props for the LoadingSpinner component. */
interface LoadingSpinnerProps {
  /** Spinner diameter: sm (16px), md (32px), or lg (48px) */
  size?: 'sm' | 'md' | 'lg';
  /** Additional CSS classes applied to the SVG element */
  className?: string;
}

/** Animated SVG spinner used as an inline loading indicator. */
export function LoadingSpinner({ size = 'md', className = '' }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-8 w-8',
    lg: 'h-12 w-12',
  };

  return (
    <svg
      className={`animate-spin text-blue-600 dark:text-blue-400 ${sizeClasses[size]} ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

/** Props for the LoadingPage component. */
interface LoadingPageProps {
  /** Text displayed below the spinner; defaults to "Loading..." */
  message?: string;
}

/** Full-screen centered loading state with a large spinner and message text. */
export function LoadingPage({ message = 'Loading...' }: LoadingPageProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="text-center">
        <LoadingSpinner size="lg" className="mx-auto mb-4" />
        <p className="text-gray-600 dark:text-gray-400">{message}</p>
      </div>
    </div>
  );
}

