import type { Request, Response } from 'express';
import { sendBadRequest, sendInternalError } from '../utils/response';

/**
 * Set SSE response headers and flush.
 * Returns an `aborted()` function to check if the client disconnected.
 */
export function initSSEStream(req: Request, res: Response, timeoutMs: number): { aborted: () => boolean } {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setTimeout(timeoutMs);
  res.flushHeaders();
  let _aborted = false;
  req.on('close', () => { _aborted = true; });
  return { aborted: () => _aborted };
}

/**
 * Classify AI generation errors and send the appropriate HTTP response or SSE event.
 * If headers are already sent (streaming), writes an SSE error event and ends the response.
 */
export function handleAIError(res: Response, message: string, fallbackMessage: string): void {
  if (!res.headersSent) {
    if (message.includes('not configured') || message.includes('API key')) {
      return sendInternalError(res, 'AI generation is not configured for the requested provider');
    }
    if (message.includes('not available for provider')) {
      return sendBadRequest(res, message);
    }
    return sendInternalError(res, fallbackMessage, { details: message });
  }
  res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
  res.end();
}
