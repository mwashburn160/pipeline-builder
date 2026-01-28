import https from 'https';
import axios, { AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import { Config } from './config.loader';
import { NetworkError } from './error.handler';
import { printDebug, printError, printWarning } from './output.utils';

/**
 * API Client for making HTTP requests
 */
export class ApiClient {
  private client: AxiosInstance;
  private config: Config;

  constructor(config: Config) {
    this.config = config;

    // Validate token before creating client
    if (!config.auth?.token) {
      throw new Error('Authentication token is required. Set PLATFORM_TOKEN environment variable.');
    }

    // Create HTTPS agent with configurable certificate validation
    const httpsAgent = new https.Agent({
      rejectUnauthorized: config.api.rejectUnauthorized ?? true, // Default to true (secure)
    });

    // Warn if certificate validation is disabled
    if (config.api.rejectUnauthorized === false) {
      printWarning('Certificate validation is disabled', {
        security: 'This should only be used in development/testing',
        risk: 'Man-in-the-middle attacks are possible',
      });
    }

    this.client = axios.create({
      baseURL: config.api.baseUrl,
      timeout: config.api.timeout || 30000,
      httpsAgent,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add request interceptor for authentication
    this.client.interceptors.request.use(
      (requestConfig) => {
        // Add authentication token from config
        // Token is guaranteed to exist because we validated in constructor
        requestConfig.headers.Authorization = `Bearer ${config.auth.token}`;

        printDebug('API Request', {
          method: requestConfig.method?.toUpperCase(),
          url: requestConfig.url,
          baseURL: requestConfig.baseURL,
          authenticated: true,
        });

        return requestConfig;
      },
      (error) => {
        printError('Request interceptor error', { error: error.message });
        return Promise.reject(error);
      },
    );

    // Add response interceptor for logging and error handling
    this.client.interceptors.response.use(
      (response) => {
        printDebug('API Response', {
          status: response.status,
          statusText: response.statusText,
          url: response.config.url,
        });
        return response;
      },
      (error: AxiosError) => {
        return this.handleError(error);
      },
    );
  }

  /**
   * Handle API errors with detailed information
   */
  private handleError(error: AxiosError): Promise<never> {
    if (error.response) {
      // Server responded with error status
      const status = error.response.status;
      const data = error.response.data;
      const url = error.config?.url;

      printError('API request failed', {
        status,
        statusText: error.response.statusText,
        url,
        data,
      });

      // Create detailed error message
      let message = `API request failed with status ${status}`;
      if (data && typeof data === 'object' && 'message' in data) {
        message = (data as any).message;
      }

      const apiError = new Error(message);
      (apiError as any).status = status;
      (apiError as any).response = error.response;
      (apiError as any).isAxiosError = true;

      return Promise.reject(apiError);

    } else if (error.request) {
      // Request made but no response received
      printError('No response received from API', {
        url: error.config?.url,
        timeout: error.config?.timeout,
      });

      const networkError = new NetworkError(
        'No response received from server. Check network connectivity.',
        error.config?.url,
        error,
      );

      return Promise.reject(networkError);

    } else {
      // Error setting up request
      printError('API request error', { error: error.message });
      return Promise.reject(error);
    }
  }

  /**
   * GET request
   *
   * @param url - Endpoint URL (relative to baseURL)
   * @param params - Query parameters
   * @param headers - Additional headers (optional)
   * @returns Response data
   */
  async get<T = any>(
    url: string,
    params?: Record<string, any>,
    headers?: Record<string, string>,
  ): Promise<T> {
    try {
      const response = await this.client.get<T>(url, {
        params,
        headers,
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * POST request with JSON body
   *
   * @param url - Endpoint URL (relative to baseURL)
   * @param data - Request body
   * @param headers - Additional headers (optional)
   * @returns Response data
   */
  async post<T = any>(
    url: string,
    data?: any,
    headers?: Record<string, string>,
  ): Promise<T> {
    try {
      const response = await this.client.post<T>(url, data, {
        headers,
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * POST request with form data
   *
   * @param url - Endpoint URL (relative to baseURL)
   * @param formData - FormData object
   * @param headers - Additional headers (optional)
   * @returns Response data
   */
  async postForm<T = any>(
    url: string,
    formData: FormData,
    headers?: Record<string, string>,
  ): Promise<T> {
    try {
      const response = await this.client.post<T>(url, formData, {
        headers: {
          ...formData.getHeaders(),
          ...headers,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * PUT request
   *
   * @param url - Endpoint URL (relative to baseURL)
   * @param data - Request body
   * @param headers - Additional headers (optional)
   * @returns Response data
   */
  async put<T = any>(
    url: string,
    data?: any,
    headers?: Record<string, string>,
  ): Promise<T> {
    try {
      const response = await this.client.put<T>(url, data, {
        headers,
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * DELETE request
   *
   * @param url - Endpoint URL (relative to baseURL)
   * @param headers - Additional headers (optional)
   * @returns Response data
   */
  async delete<T = any>(
    url: string,
    headers?: Record<string, string>,
  ): Promise<T> {
    try {
      const response = await this.client.delete<T>(url, {
        headers,
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * PATCH request
   *
   * @param url - Endpoint URL (relative to baseURL)
   * @param data - Request body
   * @param headers - Additional headers (optional)
   * @returns Response data
   */
  async patch<T = any>(
    url: string,
    data?: any,
    headers?: Record<string, string>,
  ): Promise<T> {
    try {
      const response = await this.client.patch<T>(url, data, {
        headers,
      });
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): Config {
    return this.config;
  }

  /**
   * Get base URL
   */
  getBaseUrl(): string {
    return this.config.api.baseUrl;
  }

  /**
   * Check if client is configured with authentication
   */
  isAuthenticated(): boolean {
    return !!this.config.auth?.token;
  }

  /**
   * Get authentication token (for debugging purposes only)
   * Returns masked version for security
   */
  getTokenInfo(): { present: boolean; length: number; prefix: string } {
    const token = this.config.auth?.token || '';
    return {
      present: !!token,
      length: token.length,
      prefix: token.substring(0, 4) + '...',
    };
  }
}
