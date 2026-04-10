// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic HTTP headers representation.
 */
export interface HttpHeaders {
  [key: string]: string | string[] | undefined;
}

/**
 * Generic HTTP request interface.
 * Represents the minimal request shape needed by api-core utilities.
 */
export interface HttpRequest {
  /** Request headers */
  headers: HttpHeaders;
  /** Route parameters */
  params: Record<string, string | string[] | undefined>;
  /** Query parameters */
  query: Record<string, unknown>;
  /** Authenticated user (if present) */
  user?: {
    organizationId?: string;
    userId?: string;
    role?: string;
    [key: string]: unknown;
  };
}

/**
 * Generic HTTP response interface.
 * Represents the minimal response shape needed by api-core utilities.
 */
export interface HttpResponse {
  /** Set HTTP status code */
  status(code: number): HttpResponse;
  /** Send JSON response */
  json(body: unknown): void;
  /** Set response header */
  setHeader(name: string, value: string | number): void;
}
