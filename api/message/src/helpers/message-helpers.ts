/**
 * @module helpers/message-helpers
 * @description Shared domain logic for message operations.
 *
 * Centralises filter validation and standardised error responses.
 */

import { sendEntityNotFound } from '@mwashburn160/api-core';
import { Response } from 'express';

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Send a 404 "message not found" response. */
export function sendMessageNotFound(res: Response): void {
  sendEntityNotFound(res, 'Message');
}

/** Send a 404 "thread not found" response. */
export function sendThreadNotFound(res: Response): void {
  sendEntityNotFound(res, 'Thread');
}
