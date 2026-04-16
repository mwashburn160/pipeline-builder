// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import https from 'https';
import axios, { AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import { TIMEOUTS } from '../config/cli.constants';
import { ApiError } from '../types';
import { Config } from './config-loader';
import { NetworkError } from './error-handler';
import { printDebug, printError, printWarning } from './output-utils';

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

    const httpsAgent = new https.Agent({
      rejectUnauthorized: config.api.rejectUnauthorized ?? true,
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

      printError('API request failed', { status, statusText, url, data });

      let message = `API request failed with status ${status}`;
      if (data && typeof data === 'object' && 'message' in data) {
        message = (data as { message: string }).message;
      }

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
        DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed certificate — use --no-verify-ssl',
        UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'SSL chain incomplete — use --no-verify-ssl for dev',
      };

      const hint = hints[code] || 'Check network connectivity and server status';
      const message = `${code}: ${hint} (url: ${url})`;

      return Promise.reject(new NetworkError(message, url, error));
    } else {
      printError('API request error', { error: error.message });
      return Promise.reject(error);
    }
  }

  async get<T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>): Promise<T> {
    const response = await this.client.get<T>(url, { params, headers });
    return response.data;
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
    try {
      const parts = token.split('.');
      if (parts.length !== 3 || !parts[1]) return;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
      if (payload.exp && typeof payload.exp === 'number') {
        const expiresAt = new Date(payload.exp * 1000);
        if (expiresAt.getTime() < Date.now()) {
          printWarning(`Token expired at ${expiresAt.toISOString()} — run "pipeline-manager login" to refresh`);
        }
      }
    } catch {
      // Silently ignore decode errors — server will reject invalid tokens
    }
  }
}
