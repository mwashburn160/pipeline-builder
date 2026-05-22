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
  /** Authenticated user (if present). `sub` is the OIDC-standard subject
   *  (= user id); higher-level layers may attach additional fields, hence
   *  the index signature. */
  user?: {
    sub?: string;
    organizationId?: string;
    role?: string;
    [key: string]: unknown;
  };
}

