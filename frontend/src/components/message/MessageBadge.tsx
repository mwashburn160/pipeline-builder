/** Props for the MessageBadge component. */
interface MessageBadgeProps {
  /** Number of unread messages to display; badge is hidden when zero or negative. */
  count: number;
  /** Additional CSS classes to apply to the badge element. */
  className?: string;
}

/** Red pill badge displaying the unread message count, capped at "99+". */
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
