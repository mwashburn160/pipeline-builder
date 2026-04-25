import { useState, useRef, useEffect, useId, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface TooltipProps {
  content: string;
  children: ReactNode;
  delay?: number;
}

export function Tooltip({ content, children, delay = 300 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tooltipId = useId();

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  const show = () => {
    timeoutRef.current = setTimeout(() => setVisible(true), delay);
  };

  const hide = () => {
    clearTimeout(timeoutRef.current);
    setVisible(false);
  };

  return (
    <span
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
            className="absolute z-50 pointer-events-none px-2.5 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap
              bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900
              shadow-lg left-full top-1/2 -translate-y-1/2 ml-2"
          >
            {content}
            <span className="absolute w-0 h-0 border-4 right-full top-1/2 -translate-y-1/2 border-r-gray-900 dark:border-r-gray-100 border-y-transparent border-l-transparent" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
