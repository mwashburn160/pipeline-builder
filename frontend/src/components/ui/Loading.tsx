import React from 'react';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Loading spinner component
 */
export function LoadingSpinner({ size = 'md', className = '' }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-8 w-8',
    lg: 'h-12 w-12',
  };

  return (
    <svg
      className={`animate-spin text-blue-600 ${sizeClasses[size]} ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

interface LoadingOverlayProps {
  message?: string;
}

/**
 * Full-page loading overlay
 */
export function LoadingOverlay({ message = 'Loading...' }: LoadingOverlayProps) {
  return (
    <div className="fixed inset-0 bg-white bg-opacity-75 flex items-center justify-center z-50">
      <div className="text-center">
        <LoadingSpinner size="lg" className="mx-auto mb-4" />
        <p className="text-gray-600">{message}</p>
      </div>
    </div>
  );
}

interface LoadingPageProps {
  message?: string;
}

/**
 * Loading state for pages
 */
export function LoadingPage({ message = 'Loading...' }: LoadingPageProps) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <LoadingSpinner size="lg" className="mx-auto mb-4" />
        <p className="text-gray-600">{message}</p>
      </div>
    </div>
  );
}

interface LoadingCardProps {
  rows?: number;
}

/**
 * Skeleton loading card
 */
export function LoadingCard({ rows = 3 }: LoadingCardProps) {
  return (
    <div className="bg-white rounded-lg shadow p-6 animate-pulse">
      <div className="h-4 bg-gray-200 rounded w-3/4 mb-4" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-3 bg-gray-200 rounded w-full mb-2" />
      ))}
      <div className="h-3 bg-gray-200 rounded w-1/2" />
    </div>
  );
}

interface LoadingTableProps {
  rows?: number;
  cols?: number;
}

/**
 * Skeleton loading table
 */
export function LoadingTable({ rows = 5, cols = 4 }: LoadingTableProps) {
  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="animate-pulse">
        {/* Header */}
        <div className="bg-gray-50 border-b border-gray-200 px-6 py-3 flex gap-4">
          {Array.from({ length: cols }).map((_, i) => (
            <div key={i} className="h-4 bg-gray-200 rounded flex-1" />
          ))}
        </div>
        {/* Rows */}
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div key={rowIndex} className="px-6 py-4 flex gap-4 border-b border-gray-100">
            {Array.from({ length: cols }).map((_, colIndex) => (
              <div key={colIndex} className="h-4 bg-gray-200 rounded flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface LoadingButtonProps {
  children: React.ReactNode;
  isLoading: boolean;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit' | 'reset';
  onClick?: () => void;
}

/**
 * Button with loading state
 */
export function LoadingButton({
  children,
  isLoading,
  disabled,
  className = '',
  type = 'button',
  onClick,
}: LoadingButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || isLoading}
      onClick={onClick}
      className={`inline-flex items-center justify-center ${className}`}
    >
      {isLoading && <LoadingSpinner size="sm" className="mr-2" />}
      {children}
    </button>
  );
}

export default LoadingSpinner;
