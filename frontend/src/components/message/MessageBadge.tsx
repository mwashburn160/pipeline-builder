interface MessageBadgeProps {
  count: number;
  className?: string;
}

export function MessageBadge({ count, className = '' }: MessageBadgeProps) {
  if (count <= 0) return null;

  const display = count > 99 ? '99+' : String(count);

  return (
    <span
      className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-bold text-white bg-red-500 rounded-full ${className}`}
    >
      {display}
    </span>
  );
}
