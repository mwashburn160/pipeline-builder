import { Copy, Check, X } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { COPY_FEEDBACK_RESET_MS } from '@/lib/constants';

/**
 * Button that copies the given text to the clipboard and shows a brief "Copied" confirmation.
 * Shows a "Failed" indicator if the Clipboard API is unavailable (e.g. non-HTTPS context).
 */
export function CopyButton({ text }: { text: string }) {
  const { state, copy } = useCopyToClipboard(COPY_FEEDBACK_RESET_MS);

  return (
    <button
      onClick={() => copy(text)}
      aria-label="Copy to clipboard"
      className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
    >
      {state === 'copied' ? (
        <>
          <Check className="w-3.5 h-3.5 mr-1 text-green-500" />
          Copied
        </>
      ) : state === 'failed' ? (
        <>
          <X className="w-3.5 h-3.5 mr-1 text-red-500" />
          Failed
        </>
      ) : (
        <>
          <Copy className="w-3.5 h-3.5 mr-1" />
          Copy
        </>
      )}
    </button>
  );
}
