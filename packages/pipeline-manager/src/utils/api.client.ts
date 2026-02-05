import https from 'https';
import axios, { AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import { Config } from './config.loader';
import { NetworkError } from './error.handler';
import { printDebug, printError, printWarning } from './output.utils';

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

    const httpsAgent = new https.Agent({
      rejectUnauthorized: config.api.rejectUnauthorized ?? true,
    });

    if (config.api.rejectUnauthorized === false) {
      printWarning('Certificate validation is disabled');
    }

    this.client = axios.create({
      baseURL: config.api.baseUrl,
      timeout: config.api.timeout || 30000,
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

      const apiError = new Error(message);
      (apiError as any).status = status;
      (apiError as any).response = error.response;
      (apiError as any).isAxiosError = true;

      return Promise.reject(apiError);
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

  async get<T = any>(url: string, params?: Record<string, any>, headers?: Record<string, string>): Promise<T> {
    const response = await this.client.get<T>(url, { params, headers });
    return response.data;
  }

  async post<T = any>(url: string, data?: any, headers?: Record<string, string>): Promise<T> {
    const response = await this.client.post<T>(url, data, { headers });
    return response.data;
  }

  async postForm<T = any>(url: string, formData: FormData, headers?: Record<string, string>): Promise<T> {
    const uploadTimeout = this.config.api.uploadTimeout || 15 * 60 * 1000; // default 15 minutes
    const response = await this.client.post<T>(url, formData, {
      headers: { ...formData.getHeaders(), ...headers },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: uploadTimeout,
    });
    return response.data;
  }

  async put<T = any>(url: string, data?: any, headers?: Record<string, string>): Promise<T> {
    const response = await this.client.put<T>(url, data, { headers });
    return response.data;
  }

  async delete<T = any>(url: string, headers?: Record<string, string>): Promise<T> {
    const response = await this.client.delete<T>(url, { headers });
    return response.data;
  }

  async patch<T = any>(url: string, data?: any, headers?: Record<string, string>): Promise<T> {
    const response = await this.client.patch<T>(url, data, { headers });
    return response.data;
  }

  getConfig(): Config { return this.config; }
  getBaseUrl(): string { return this.config.api.baseUrl; }
  isAuthenticated(): boolean { return !!this.config.auth?.token; }
}
