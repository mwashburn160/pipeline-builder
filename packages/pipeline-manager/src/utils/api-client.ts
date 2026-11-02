// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import https from 'https';
import { describeQuotaExceeded, platformCaList } from '@pipeline-builder/pipeline-core';
import axios, { type AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import { decodeTokenPayload } from './auth-guard.js';
import { type Config } from './config-loader.js';
import { NetworkError } from './error-handler.js';
import { printDebug, printError, printWarning } from './output-utils.js';
import { requestCorrelationHeaders } from './request-context.js';
import { TIMEOUTS } from '../config/cli.constants.js';
import { ApiError } from '../types/index.js';

/**
 * API Client for making HTTP requests to the platform API
 */
export class ApiClient {
  private client: AxiosInstance;
  private config: Config;

  constructor(config: Config) {
    this.config = config;

    if (!config.auth?.token) {
      throw new Error('Authentication token is required. Set PLATFORM_TOKEN environment variable.');
    }

    // Warn if token appears expired (advisory — server validates authoritatively)
    this.checkTokenExpiry(config.auth.token);

    // A private-CA platform (PLATFORM_CA_BUNDLE) is trusted on top of Node's
    // roots — verified, not skipped. See pipeline-core core/platform-tls.ts.
    const ca = platformCaList();
    const httpsAgent = new https.Agent({
      rejectUnauthorized: config.api.rejectUnauthorized ?? true,
      ...(ca && { ca }),
    });

    if (config.api.rejectUnauthorized === false) {
      printWarning('Certificate validation is disabled');
    }

    this.client = axios.create({
      baseURL: config.api.baseUrl,
      timeout: config.api.timeout || TIMEOUTS.HTTP_REQUEST,
      httpsAgent,
      headers: { 'Content-Type': 'application/json' },
    });

    // Auth interceptor
    this.client.interceptors.request.use(
      (requestConfig) => {
        requestConfig.headers.Authorization = `Bearer ${config.auth.token}`;
        // Audit correlation (X-Request-Id, and in CodeBuild the build + execution
        // ids) so the server's audit row joins back to this run. See request-context.
        for (const [name, value] of Object.entries(requestCorrelationHeaders())) {
          requestConfig.headers[name] = value;
        }
        printDebug('API Request', {
          method: requestConfig.method?.toUpperCase(),
          url: requestConfig.url,
          baseURL: requestConfig.baseURL,
        });
        return requestConfig;
      },
      (error) => {
        printError('Request interceptor error', { error: error.message });
        return Promise.reject(error);
      },
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        printDebug('API Response', {
          status: response.status,
          statusText: response.statusText,
          url: response.config.url,
        });
        return response;
      },
      (error: AxiosError) => this.handleError(error),
    );
  }

  private handleError(error: AxiosError): Promise<never> {
    if (error.response) {
      const { status, statusText, data } = error.response;
      const url = error.config?.url;

      // The response body (`data`) can carry tokens/PII, and printError always writes
      // (not gated on DEBUG) — keep it out of the always-on line; surface it only under DEBUG.
      printError('API request failed', { status, statusText, url });
      printDebug('API error response body', { data });

      let message = `API request failed with status ${status}`;
      if (data && typeof data === 'object' && 'message' in data && typeof (data as { message: unknown }).message === 'string') {
        message = (data as { message: string }).message;
      }
      // A QUOTA refusal reads as what it is — which quota, how much, when it
      // resets and where to raise it — not as a rate limit to wait out. A 429
      // without the QUOTA_EXCEEDED code keeps the server's message.
      if (status === 429) message = describeQuotaExceeded(data, this.config.api.baseUrl) ?? message;

      return Promise.reject(new ApiError(message, status, error.response));
    } else if (error.request) {
      const code = error.code || 'UNKNOWN';
      const url = error.config?.url;
      const timeout = error.config?.timeout;
      const cause = error.cause;

      printError('No response received from API', {
        url,
        timeout,
        code,
        ...(cause instanceof Error ? { cause: cause.message } : {}),
      });

      const hints: Record<string, string> = {
        ECONNREFUSED: 'Server is not running or port is wrong',
        ECONNRESET: 'Server closed the connection unexpectedly',
        ETIMEDOUT: 'Connection timed out — server unreachable or too slow',
        ENOTFOUND: 'DNS lookup failed — check the hostname in baseUrl',
        ERR_BAD_REQUEST: 'Request was malformed — check the endpoint and payload',
        CERT_HAS_EXPIRED: 'SSL certificate expired — use --no-verify-ssl for dev',
        DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed certificate — set PLATFORM_CA_BUNDLE to its CA (PEM), or --no-verify-ssl for dev',
        UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'SSL chain incomplete — set PLATFORM_CA_BUNDLE to the issuing CA (PEM), or --no-verify-ssl for dev',
        SELF_SIGNED_CERT_IN_CHAIN: 'Private CA in chain — set PLATFORM_CA_BUNDLE to that CA (PEM)',
      };

      const hint = hints[code] || 'Check network connectivity and server status';
      const message = `${code}: ${hint} (url: ${url})`;

      return Promise.reject(new NetworkError(message, url, error, timeout));
    } else {
      printError('API request error', { error: error.message });
      return Promise.reject(error);
    }
  }

  async get<T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>): Promise<T> {
    const response = await this.client.get<T>(url, { params, headers });
    return response.data;
  }

  /**
   * A BINARY download (a report PDF): the bytes, plus the file name the server chose.
   *
   * `responseType: 'arraybuffer'` because the default would hand back a UTF-8 string and
   * corrupt every byte above 0x7f — a PDF written that way opens as a damaged file, which
   * looks like a server bug rather than a client one.
   *
   * The server's `Content-Disposition` name is preferred over anything the caller guesses:
   * it knows the report's title and whether the run is a revision.
   */
  async getBinary(url: string, headers?: Record<string, string>): Promise<{ data: Buffer; filename?: string }> {
    const response = await this.client.get<ArrayBuffer>(url, { headers, responseType: 'arraybuffer' });
    const disposition = String(response.headers['content-disposition'] ?? '');
    const match = /filename="([^"]+)"/.exec(disposition);
    return {
      data: Buffer.from(response.data),
      ...(match?.[1] ? { filename: match[1] } : {}),
    };
  }

  async post<T = unknown>(url: string, data?: unknown, headers?: Record<string, string>): Promise<T> {
    const response = await this.client.post<T>(url, data, { headers });
    return response.data;
  }

  async postForm<T = unknown>(url: string, formData: FormData, headers?: Record<string, string>): Promise<T> {
    const uploadTimeout = this.config.api.uploadTimeout || 15 * 60 * 1000; // default 15 minutes
    const response = await this.client.post<T>(url, formData, {
      headers: { ...formData.getHeaders(), ...headers },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: uploadTimeout,
    });
    return response.data;
  }

  async put<T = unknown>(url: string, data?: unknown, headers?: Record<string, string>): Promise<T> {
    const response = await this.client.put<T>(url, data, { headers });
    return response.data;
  }

  async delete<T = unknown>(url: string, headers?: Record<string, string>): Promise<T> {
    const response = await this.client.delete<T>(url, { headers });
    return response.data;
  }

  async patch<T = unknown>(url: string, data?: unknown, headers?: Record<string, string>): Promise<T> {
    const response = await this.client.patch<T>(url, data, { headers });
    return response.data;
  }

  getConfig(): Config { return this.config; }
  getBaseUrl(): string { return this.config.api.baseUrl; }
  isAuthenticated(): boolean { return !!this.config.auth?.token; }

  /**
   * Advisory check: decode JWT exp claim and warn if expired.
   * Does NOT verify signature — server handles that.
   */
  private checkTokenExpiry(token: string): void {
    const payload = decodeTokenPayload(token);
    if (payload && typeof payload.exp === 'number') {
      const expiresAt = new Date(payload.exp * 1000);
      if (expiresAt.getTime() < Date.now()) {
        printWarning(`Token expired at ${expiresAt.toISOString()} — run "pipeline-manager auth login" to refresh`);
      }
    }
  }
}
