// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The api client, composed of one layer per concern (see `./client/`), each
 * extending the one before it:
 *
 *  - `session`        the in-memory access token, its org, listeners, the
 *                     session's idle state and the cross-tab auth channel;
 *  - `refresh`        trading the refresh cookie for a new token under the
 *                     cross-tab Web Lock, with backoff, cooldown and the
 *                     activity signal;
 *  - `impersonation`  starting, stopping and revoking impersonation, and
 *                     restoring the operator's session after a reload;
 *  - `request`        the request/response contract (401 refresh, step-up,
 *                     MFA, 503 backoff, quota notices, `ApiError`);
 *  - `stream`         Server-Sent Events from a POST endpoint.
 *
 * Types and constants are imported from the layer that owns them.
 */

import { StreamingClient } from './client/stream';

/** API client for communicating with the backend. */
export class ApiCore extends StreamingClient {}
