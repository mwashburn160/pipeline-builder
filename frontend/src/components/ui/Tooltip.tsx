import { useState, useRef, useEffect, useLayoutEffect, useId, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface TooltipProps {
  content: string;
  children: ReactNode;
  delay?: number;
}

type Side = 'right' | 'left' | 'top' | 'bottom';

/**
 * Approximate width budget the tooltip + arrow needs on either side of
 * the trigger. The tooltip itself is `whitespace-nowrap` and varies with
 * the content length, so this is a conservative reservation rather than
 * a measured value — we only flip when there is clearly no room.
 */
const SIDE_GUTTER_PX = 200;

/**
 * Per-side positioning classes. The arrow's class set mirrors the
 * tooltip's anchor edge so the triangle points back at the trigger.
 */
const SIDE_CLASSES: Record<Side, { tooltip: string; arrow: string }> = {
  right: {
    tooltip: 'left-full top-1/2 -translate-y-1/2 ml-2',
    arrow: 'right-full top-1/2 -translate-y-1/2 border-r-gray-900 dark:border-r-gray-100 border-y-transparent border-l-transparent',
  },
  left: {
    tooltip: 'right-full top-1/2 -translate-y-1/2 mr-2',
    arrow: 'left-full top-1/2 -translate-y-1/2 border-l-gray-900 dark:border-l-gray-100 border-y-transparent border-r-transparent',
  },
  top: {
    tooltip: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    arrow: 'top-full left-1/2 -translate-x-1/2 border-t-gray-900 dark:border-t-gray-100 border-x-transparent border-b-transparent',
  },
  bottom: {
    tooltip: 'top-full left-1/2 -translate-x-1/2 mt-2',
    arrow: 'bottom-full left-1/2 -translate-x-1/2 border-b-gray-900 dark:border-b-gray-100 border-x-transparent border-t-transparent',
  },
};

/**
 * Hover tooltip. Defaults to rendering on the right of the trigger; when
 * the trigger sits close to the right viewport edge (e.g. last column of
 * a table, action button in a narrow right pane), flips to left to avoid
 * clipping. Falls back to top/bottom only if neither horizontal side has
 * room — rare in this app's layouts.
 */
export function Tooltip({ content, children, delay = 300 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [side, setSide] = useState<Side>('right');
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  // Pick a side just before the tooltip becomes visible. Re-measure on
  // every show so scroll position / viewport resize since the last show
  // is taken into account.
  useLayoutEffect(() => {
    if (!visible || !wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rightRoom = vw - rect.right;
    const leftRoom = rect.left;
    const bottomRoom = vh - rect.bottom;
    const topRoom = rect.top;

    if (rightRoom >= SIDE_GUTTER_PX) setSide('right');
    else if (leftRoom >= SIDE_GUTTER_PX) setSide('left');
    else if (bottomRoom >= 60) setSide('bottom');
    else if (topRoom >= 60) setSide('top');
    else setSide('right'); // best effort — clipping is unavoidable
  }, [visible]);

  const show = () => {
    timeoutRef.current = setTimeout(() => setVisible(true), delay);
  };

  const hide = () => {
    clearTimeout(timeoutRef.current);
    setVisible(false);
  };

  const sideClasses = SIDE_CLASSES[side];

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={visible ? tooltipId : undefined}
    >
      {children}
      <AnimatePresence>
        {visible && (
          <motion.span
            id={tooltipId}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1 }}
            role="tooltip"
            className={`absolute z-50 pointer-events-none px-2.5 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap
              bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900
              shadow-lg ${sideClasses.tooltip}`}
          >
            {content}
            <span className={`absolute w-0 h-0 border-4 ${sideClasses.arrow}`} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
