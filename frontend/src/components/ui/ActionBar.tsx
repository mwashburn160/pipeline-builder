import { type ReactNode } from 'react';

interface ActionBarProps {
  left: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function ActionBar({ left, right, className = '' }: ActionBarProps) {
  return (
    <div className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${className}`}>
      <div className="flex-1 min-w-0">{left}</div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}
