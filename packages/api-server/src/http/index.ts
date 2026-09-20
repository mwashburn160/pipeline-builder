// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// `SSE_REQUEST_ID_RE` is the format guard `createApp` and the manager apply
// themselves — callers never re-validate.
export {
  SSEManager,
  type SSEEventType,
  type SSEPayload,
  type SSEClient,
  type SSEManagerOptions,
  type CreateTicketResult,
  type SSEManagerStats,
} from './sse-connection-manager.js';
export * from './sse-ticket-channel.js';
// The Redis SSE relay is wired by `createApp` (`relayFactory`); nothing outside
// this package constructs one, so it stays off the public barrel.
