import { Copy, Check, X } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { COPY_FEEDBACK_RESET_MS } from '@/lib/constants';
import { Button } from './Button';

/**
 * Button that copies the given text to the clipboard and shows a brief "Copied" confirmation.
 * Shows a "Failed" indicator if the Clipboard API is unavailable (e.g. non-HTTPS context).
 */
export function CopyButton({ text }: { text: string }) {
  const { state, copy } = useCopyToClipboard(COPY_FEEDBACK_RESET_MS);

  return (
    <Button variant="outline" size="xs" onClick={() => copy(text)} aria-label="Copy to clipboard">
      {state === 'copied' ? (
        <>
          <Check className="w-3.5 h-3.5 mr-1 text-success" />
          Copied
        </>
      ) : state === 'failed' ? (
        <>
          <X className="w-3.5 h-3.5 mr-1 text-danger" />
          Failed
        </>
      ) : (
        <>
          <Copy className="w-3.5 h-3.5 mr-1" />
          Copy
        </>
      )}
    </Button>
  );
}
