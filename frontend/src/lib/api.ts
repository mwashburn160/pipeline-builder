import { AuthTokens, ApiResponse, CreatePipelineData, BuilderProps, Organization, OrganizationMember, OrgQuotaResponse, OrgAIConfig, Invitation, LogQueryResult, Plugin, Pipeline, User, Plan, Subscription, BillingEvent, BillingInterval, Message, MessageType, MessagePriority, QueueStatus } from '@/types';
import { REFRESH_BUFFER_MS, MAX_REFRESH_ATTEMPTS, API_REQUEST_TIMEOUT_MS } from './constants';

// Use relative URL in browser (requests go through nginx), absolute URL for SSR
const API_URL = typeof window !== 'undefined' ? '' : (process.env.PLATFORM_BASE_URL || 'https://localhost:8443');

/** Build a query string from optional params, filtering out undefined/empty values. */
function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => [k, String(v)]);
  return entries.length ? '?' + new URLSearchParams(entries).toString() : '';
}

export function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return atob(base64);
}

export class ApiError extends Error {
  statusCode: number;
  code?: string;
  details?: Record<string, unknown>;
  /** Seconds to wait before retrying (from Retry-After header on 429 responses). */
  retryAfter?: number;

  constructor(message: string, statusCode: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** SSE event received from AI streaming endpoints. */
export interface StreamEvent {
  type: 'partial' | 'done' | 'error' | 'analyzing' | 'analyzed' | 'checking-plugins' | 'creating-plugins';
  data?: unknown;
  message?: string;
}

/**
 * API Client for communicating with the backend
 */
class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private organizationId: string | null = null;
  private isRefreshing = false;
  private refreshPromise: Promise<boolean> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshAttempts = 0;
  private sessionExpiredCallbacks: Set<() => void> = new Set();

  private static REFRESH_BUFFER_MS = REFRESH_BUFFER_MS;
  private static MAX_REFRESH_ATTEMPTS = MAX_REFRESH_ATTEMPTS;

  /**
   * Register a callback invoked when the session expires (refresh fails).
   * Returns an unsubscribe function.
   */
  onSessionExpired(callback: () => void): () => void {
    this.sessionExpiredCallbacks.add(callback);
    return () => { this.sessionExpiredCallbacks.delete(callback); };
  }

  private notifySessionExpired(): void {
    this.sessionExpiredCallbacks.forEach(cb => {
      try { cb(); } catch { /* ignore listener errors */ }
    });
  }

  constructor() {
    if (typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem('accessToken');
      this.refreshToken = localStorage.getItem('refreshToken');
      this.organizationId = localStorage.getItem('organizationId');
      this.scheduleProactiveRefresh();
    }
  }

  /**
   * Decode the access token's `exp` claim and return it as a ms timestamp.
   * Returns null if the token is missing or unparseable.
   */
  private getTokenExpiryMs(): number | null {
    if (!this.accessToken) return null;
    try {
      const payload = JSON.parse(base64UrlDecode(this.accessToken.split('.')[1]));
      return payload.exp ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  /**
   * Schedule a background timer to refresh the token before it expires.
   * Falls back gracefully if the token can't be decoded.
   */
  private scheduleProactiveRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    const expiryMs = this.getTokenExpiryMs();
    if (!expiryMs || !this.refreshToken) return;

    const delay = expiryMs - Date.now() - ApiClient.REFRESH_BUFFER_MS;
    if (delay <= 0) return; // already past the refresh window — let the pre-request check handle it

    this.refreshTimer = setTimeout(async () => {
      await this.refreshAccessToken();
    }, delay);
  }

  /**
   * If the token expires within the buffer window, refresh it now.
   * Called before every authenticated request as a safety net.
   */
  private async ensureFreshToken(): Promise<void> {
    if (!this.accessToken || !this.refreshToken) return;

    const expiryMs = this.getTokenExpiryMs();
    if (!expiryMs) return;

    if (expiryMs - Date.now() <= ApiClient.REFRESH_BUFFER_MS) {
      await this.refreshAccessToken();
    }
  }

  /**
   * Set authentication tokens
   */
  setTokens(tokens: AuthTokens) {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    
    if (typeof window !== 'undefined') {
      localStorage.setItem('accessToken', tokens.accessToken);
      localStorage.setItem('refreshToken', tokens.refreshToken);
      
      // Extract organizationId from JWT token if present
      try {
        const payload = JSON.parse(base64UrlDecode(tokens.accessToken.split('.')[1]));
        if (payload.organizationId) {
          this.organizationId = payload.organizationId;
          localStorage.setItem('organizationId', payload.organizationId);
        }
      } catch {
        // JWT parsing failed - non-critical
      }
    }

    this.scheduleProactiveRefresh();
  }

  /**
   * Set organization ID for API requests
   */
  setOrganizationId(orgId: string) {
    this.organizationId = orgId;
    if (typeof window !== 'undefined') {
      localStorage.setItem('organizationId', orgId);
    }
  }

  /**
   * Get current organization ID
   */
  getOrganizationId() {
    return this.organizationId;
  }

  /**
   * Clear all authentication data
   */
  clearTokens() {
    this.accessToken = null;
    this.refreshToken = null;
    this.organizationId = null;

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (typeof window !== 'undefined') {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('organizationId');
    }
  }

  /**
   * Get current access token
   */
  getAccessToken() {
    return this.accessToken;
  }

  getRefreshToken() {
    return this.refreshToken;
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    return !!this.accessToken;
  }

  /** If response contains tokens, store them. */
  private applyTokens(response: ApiResponse<{ accessToken: string; refreshToken: string }>): void {
    const tokens = response.data;
    if (response.success && tokens?.accessToken && tokens?.refreshToken) {
      this.setTokens(tokens);
    }
  }

  /** Build auth + org headers for the current session. */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;
    if (this.organizationId) headers['x-org-id'] = this.organizationId;
    return headers;
  }

  /**
   * Make an API request
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    _retryCount = 0,
  ): Promise<T> {
    // Proactively refresh token before it expires (skip for auth endpoints)
    if (!endpoint.includes('/auth/')) {
      await this.ensureFreshToken();
    }

    const url = `${API_URL}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.authHeaders(),
      ...(options.headers as Record<string, string>),
    };

    // Apply default timeout unless caller already provided an AbortSignal
    const controller = options.signal ? undefined : new AbortController();
    const timeoutId = controller ? setTimeout(() => controller.abort(`Request timeout after ${API_REQUEST_TIMEOUT_MS}ms`), API_REQUEST_TIMEOUT_MS) : undefined;

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'same-origin',
      signal: options.signal || controller?.signal,
    }).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });

    // Parse JSON response
    const data = await response.json().catch(() => ({ 
      statusCode: response.status, 
      message: 'Request failed',
      success: false,
    }));
    
    const statusCode = data.statusCode || response.status;

    // Handle 401 - try to refresh token
    if (statusCode === 401 && this.refreshToken && !endpoint.includes('/auth/refresh')) {
      const refreshed = await this.refreshAccessToken();
      
      if (refreshed) {
        headers['Authorization'] = `Bearer ${this.accessToken}`;
        const retryResponse = await fetch(url, {
          ...options,
          headers,
          credentials: 'same-origin',
        });
        
        const retryData = await retryResponse.json().catch(() => ({ 
          statusCode: retryResponse.status, 
          message: 'Request failed',
          success: false,
        }));
        
        const retryStatusCode = retryData.statusCode || retryResponse.status;

        if (retryStatusCode >= 400) {
          throw new ApiError(
            retryData.message || 'Request failed',
            retryStatusCode,
            retryData.code,
            retryData.details
          );
        }
        return retryData;
      }
    }

    // Retry on 503 (server overloaded / request timeout) — up to 2 retries with backoff
    if (statusCode === 503 && _retryCount < 2 && !options.method?.match(/POST|PUT|DELETE/i)) {
      await new Promise(r => setTimeout(r, 1000 * (_retryCount + 1)));
      return this.request<T>(endpoint, options, _retryCount + 1);
    }

    // Check statusCode from response body
    if (statusCode >= 400) {
      // Strip HTML tags from server error messages to prevent XSS
      const safeMessage = typeof data.message === 'string'
        ? data.message.replace(/<[^>]*>/g, '')
        : 'Request failed';
      const error = new ApiError(
        safeMessage,
        statusCode,
        data.code,
        data.details
      );
      // Extract Retry-After header for rate-limited responses
      if (statusCode === 429) {
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
          error.retryAfter = parseInt(retryAfter, 10) || undefined;
        }
      }
      throw error;
    }

    return data;
  }

  /**
   * Refresh access token using refresh token
   */
  private async refreshAccessToken(): Promise<boolean> {
    // Prevent multiple simultaneous refresh requests
    if (this.isRefreshing && this.refreshPromise) {
      return this.refreshPromise;
    }

    this.isRefreshing = true;
    this.refreshPromise = this.doRefresh();
    
    try {
      return await this.refreshPromise;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<boolean> {
    if (this.refreshAttempts >= ApiClient.MAX_REFRESH_ATTEMPTS) {
      this.clearTokens();
      this.notifySessionExpired();
      return false;
    }

    this.refreshAttempts++;

    try {
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      const data = await response.json().catch(() => ({ statusCode: response.status }));
      const statusCode = data.statusCode || response.status;

      // Check for tokens in data.data (standardized response) or data directly
      const tokens = data.data || data;

      if (statusCode < 400 && tokens.accessToken) {
        this.refreshAttempts = 0; // Reset on success
        this.setTokens(tokens);
        return true;
      }
    } catch {
      // Refresh failed
    }

    this.clearTokens();
    this.notifySessionExpired();
    return false;
  }

  // ============================================
  // Config endpoints (public)
  // ============================================

  /** Get platform service feature flags (public, no auth required). */
  async getConfig() {
    return this.request<ApiResponse<{ serviceFeatures: Record<string, boolean> }>>('/api/config');
  }

  // ============================================
  // Auth endpoints
  // ============================================

  async login(email: string, password: string) {
    const response = await this.request<ApiResponse<{ accessToken: string; refreshToken: string }>>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: email, password }),
    });
    this.applyTokens(response);
    return response;
  }

  async register(username: string, email: string, password: string, organizationName?: string, planId?: string) {
    return this.request<ApiResponse<{ user: User }>>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, organizationName, planId }),
    });
  }

  async logout() {
    try {
      await this.request('/api/auth/logout', { method: 'POST' });
    } finally {
      this.clearTokens();
    }
  }

  async getProfile() {
    return this.request<ApiResponse<{ user: User }>>('/api/user/profile');
  }

  async updateProfile(data: { username?: string; email?: string }) {
    return this.request<ApiResponse<{ user: User }>>('/api/user/profile', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async changePassword(currentPassword: string, newPassword: string) {
    return this.request<ApiResponse<{ message: string }>>('/api/user/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  async deleteAccount() {
    const response = await this.request<ApiResponse<{ message: string }>>('/api/user/account', {
      method: 'DELETE',
    });
    this.clearTokens();
    return response;
  }

  /**
   * Generate a new token pair via POST /user/generate-token
   */
  async generateNewToken() {
    const response = await this.request<ApiResponse<{ accessToken: string; refreshToken: string }>>(
      '/api/user/generate-token',
      { method: 'POST' },
    );
    this.applyTokens(response);
    return response;
  }

  // ============================================
  // Organization endpoints
  // ============================================

  async getMyOrganization() {
    return this.request<ApiResponse<Organization>>('/api/organization');
  }

  async listOrganizations() {
    return this.request<ApiResponse<{ organizations: Organization[]; total: number; page: number; limit: number; totalPages: number }>>('/api/organizations');
  }

  async getOrganization(id: string) {
    return this.request<ApiResponse<Organization>>(`/api/organization/${id}`);
  }

  async updateOrganization(id: string, data: { name?: string; description?: string }) {
    return this.request<ApiResponse<Organization>>(`/api/organization/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteOrganization(id: string) {
    return this.request<ApiResponse<{ message: string }>>(`/api/organization/${id}`, {
      method: 'DELETE',
    });
  }

  async getOrganizationMembers(orgId: string) {
    return this.request<ApiResponse<{ members: OrganizationMember[] }>>(`/api/organization/${orgId}/members`);
  }

  async addMemberToOrganization(orgId: string, data: { userId?: string; email?: string }) {
    return this.request<ApiResponse<OrganizationMember>>(`/api/organization/${orgId}/members`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async removeMemberFromOrganization(orgId: string, userId: string) {
    return this.request<ApiResponse<{ message: string }>>(`/api/organization/${orgId}/members/${userId}`, {
      method: 'DELETE',
    });
  }

  async updateMemberRole(orgId: string, userId: string, role: 'user' | 'admin') {
    return this.request<ApiResponse<OrganizationMember>>(`/api/organization/${orgId}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
  }

  async transferOrganizationOwnership(orgId: string, newOwnerId: string) {
    return this.request<ApiResponse<{ message: string }>>(`/api/organization/${orgId}/transfer-owner`, {
      method: 'PATCH',
      body: JSON.stringify({ newOwnerId }),
    });
  }

  async getOrgAIConfig() {
    return this.request<ApiResponse<OrgAIConfig>>('/api/organization/ai-config');
  }

  async updateOrgAIConfig(data: Record<string, string | null>) {
    return this.request<ApiResponse<OrgAIConfig>>('/api/organization/ai-config', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // ============================================
  // User management endpoints (Admin)
  // ============================================

  async listUsers(params?: { organizationId?: string; role?: string; search?: string; page?: number; limit?: number }) {
    return this.request<ApiResponse<{ users: User[]; total: number; page: number; limit: number; totalPages: number }>>(`/api/users${buildQuery(params)}`);
  }

  async getUserById(id: string) {
    return this.request<ApiResponse<{ user: User }>>(`/api/users/${id}`);
  }

  async updateUserById(id: string, data: { username?: string; email?: string; role?: string; organizationId?: string | null; password?: string }) {
    return this.request<ApiResponse<{ user: User }>>(`/api/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteUserById(id: string) {
    return this.request<ApiResponse<{ message: string }>>(`/api/users/${id}`, {
      method: 'DELETE',
    });
  }

  async updateUserFeatures(userId: string, overrides: Record<string, boolean>) {
    return this.request<ApiResponse<{ user: User }>>(`/api/users/${userId}/features`, {
      method: 'PUT',
      body: JSON.stringify({ overrides }),
    });
  }

  // ============================================
  // Quota endpoints (quota service — nginx proxies /api/quota → quota:3000/quotas)
  // ============================================

  /** Get quotas for the requesting user's org (from JWT). */
  async getOwnQuotas() {
    return this.request<ApiResponse<{ quota: OrgQuotaResponse }>>('/api/quota');
  }

  /** Get all orgs with quotas (system admin only). */
  async getAllOrgQuotas() {
    return this.request<ApiResponse<{ organizations: OrgQuotaResponse[]; total: number }>>('/api/quota/all');
  }

  /** Get quotas for a specific org. */
  async getOrgQuotas(orgId: string) {
    return this.request<ApiResponse<{ quota: OrgQuotaResponse }>>(`/api/quota/${orgId}`);
  }

  /** Update org name, slug, and/or quotas (system admin only). */
  async updateOrgQuotas(orgId: string, data: { name?: string; slug?: string; quotas?: Record<string, number> }) {
    return this.request<ApiResponse<{ quota: OrgQuotaResponse }>>(`/api/quota/${orgId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** Reset usage counters (system admin only). */
  async resetOrgQuotaUsage(orgId: string, quotaType?: string) {
    return this.request<ApiResponse<{ quota: OrgQuotaResponse }>>(`/api/quota/${orgId}/reset`, {
      method: 'POST',
      body: JSON.stringify(quotaType ? { quotaType } : {}),
    });
  }

  // ============================================
  // Billing endpoints (billing service — nginx proxies /api/billing → billing:3000/billing)
  // ============================================

  /** Get all available plans (public, no auth required). */
  async getPlans() {
    return this.request<ApiResponse<{ plans: Plan[]; total: number }>>('/api/billing/plans');
  }

  /** Get a single plan by ID. */
  async getPlan(planId: string) {
    return this.request<ApiResponse<{ plan: Plan }>>(`/api/billing/plans/${planId}`);
  }

  /** Get current org subscription. */
  async getSubscription() {
    return this.request<ApiResponse<{ subscription: Subscription | null }>>('/api/billing/subscriptions');
  }

  /** Create a new subscription. */
  async createSubscription(planId: string, interval: BillingInterval = 'monthly') {
    return this.request<ApiResponse<{ subscription: Subscription }>>('/api/billing/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ planId, interval }),
    });
  }

  /** Change plan or interval on an existing subscription. */
  async changeSubscription(id: string, data: { planId?: string; interval?: BillingInterval }) {
    return this.request<ApiResponse<{ subscription: Subscription }>>(`/api/billing/subscriptions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** Cancel subscription at end of current period. */
  async cancelSubscription(id: string) {
    return this.request<ApiResponse<{ subscription: Subscription; message: string }>>(`/api/billing/subscriptions/${id}/cancel`, {
      method: 'POST',
    });
  }

  /** Reactivate a canceled subscription. */
  async reactivateSubscription(id: string) {
    return this.request<ApiResponse<{ subscription: Subscription; message: string }>>(`/api/billing/subscriptions/${id}/reactivate`, {
      method: 'POST',
    });
  }

  /** List all subscriptions (admin only). */
  async listSubscriptions(params?: { status?: string; limit?: number; offset?: number }) {
    return this.request<ApiResponse<{ subscriptions: Subscription[]; total: number }>>(`/api/billing/admin/subscriptions${buildQuery(params)}`);
  }

  /** List billing events (admin only). */
  async listBillingEvents(params?: { orgId?: string; limit?: number; offset?: number }) {
    return this.request<ApiResponse<{ events: BillingEvent[]; total: number }>>(`/api/billing/admin/events${buildQuery(params)}`);
  }

  // ============================================
  // Plugin endpoints
  // ============================================

  async listPlugins(params?: Record<string, string>) {
    return this.request<ApiResponse<{ plugins: Plugin[]; pagination: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/plugins${buildQuery(params)}`);
  }

  async getPluginById(id: string) {
    return this.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugin/${id}`);
  }

  async searchPlugins(params: Record<string, string>) {
    return this.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugins/find${buildQuery(params)}`);
  }

  async uploadPlugin(file: File, accessModifier: 'public' | 'private' = 'private', options?: { signal?: AbortSignal }) {
    const formData = new FormData();
    formData.append('plugin', file);
    formData.append('accessModifier', accessModifier);

    const response = await fetch(`${API_URL}/api/plugin/upload`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: formData,
      signal: options?.signal,
    });

    const data = await response.json().catch(() => ({ 
      statusCode: response.status, 
      message: 'Upload failed',
      success: false,
    }));
    
    const statusCode = data.statusCode || response.status;

    if (statusCode >= 400) {
      throw new ApiError(data.message || 'Upload failed', statusCode, data.code);
    }

    return data as ApiResponse<{
      requestId?: string;
      pluginName?: string;
      imageTag?: string;
    }>;
  }

  async getQueueStatus() {
    return this.request<ApiResponse<QueueStatus>>('/api/plugin/queue/status');
  }

  async updatePlugin(id: string, data: {
    name?: string;
    description?: string;
    keywords?: string[];
    version?: string;
    metadata?: Record<string, string | number | boolean>;
    pluginType?: string;
    computeType?: string;
    env?: Record<string, string>;
    installCommands?: string[];
    commands?: string[];
    accessModifier?: 'public' | 'private';
    isDefault?: boolean;
    isActive?: boolean;
    primaryOutputDirectory?: string | null;
    timeout?: number | null;
    failureBehavior?: 'fail' | 'warn' | 'ignore';
    secrets?: Array<{ name: string; required: boolean; description?: string }>;
  }) {
    return this.request<ApiResponse<{ plugin: Plugin }>>(`/api/plugin/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deletePlugin(id: string) {
    return this.request<ApiResponse<{ message: string }>>(`/api/plugin/${id}`, {
      method: 'DELETE',
    });
  }

  // ============================================
  // Pipeline endpoints
  // ============================================

  async listPipelines(params?: Record<string, string>) {
    return this.request<ApiResponse<{ pipelines: Pipeline[]; pagination: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/pipelines${buildQuery(params)}`);
  }

  async getPipelineById(id: string) {
    return this.request<ApiResponse<{ pipeline: Pipeline }>>(`/api/pipeline/${id}`);
  }

  async searchPipelines(params: Record<string, string>) {
    return this.request<ApiResponse<{ pipeline: Pipeline }>>(`/api/pipelines/find${buildQuery(params)}`);
  }

  async createPipeline(data: CreatePipelineData) {
    return this.request<ApiResponse<{ pipeline: Pipeline; warning?: string }>>('/api/pipeline', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updatePipeline(id: string, data: { 
    pipelineName?: string;
    description?: string;
    keywords?: string[];
    props?: BuilderProps;
    accessModifier?: 'public' | 'private';
    isDefault?: boolean;
    isActive?: boolean;
  }) {
    return this.request<ApiResponse<{ pipeline: Pipeline }>>(`/api/pipeline/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deletePipeline(id: string) {
    return this.request<ApiResponse<{ message: string }>>(`/api/pipeline/${id}`, {
      method: 'DELETE',
    });
  }

  async getAIProviders() {
    return this.request<ApiResponse<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>>('/api/pipeline/providers');
  }

  async generatePipeline(prompt: string, provider: string, model: string, apiKey?: string) {
    return this.request<ApiResponse<{ props: BuilderProps; description?: string; keywords?: string[] }>>('/api/pipeline/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt, provider, model, ...(apiKey ? { apiKey } : {}) }),
    });
  }

  /**
   * Stream SSE events from a POST endpoint.
   * Yields parsed StreamEvent objects as they arrive.
   */
  async *streamRequest(
    endpoint: string,
    body: Record<string, unknown>,
  ): AsyncGenerator<StreamEvent> {
    await this.ensureFreshToken();

    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });

    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({ message: 'Stream failed' }));
      throw new ApiError(data.message || 'Stream failed', response.status, data.code);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') return;
            try {
              yield JSON.parse(data) as StreamEvent;
            } catch { /* skip malformed SSE data */ }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Stream AI pipeline generation with progressive partial results.
   */
  async *streamPipelineGeneration(prompt: string, provider: string, model: string, apiKey?: string) {
    yield* this.streamRequest('/api/pipeline/generate/stream', {
      prompt, provider, model, ...(apiKey ? { apiKey } : {}),
    });
  }

  /**
   * Stream AI pipeline generation from a Git URL.
   * Yields analyzing → analyzed → partial → done events.
   */
  async *streamPipelineFromUrl(gitUrl: string, provider: string, model: string, apiKey?: string, repoToken?: string) {
    yield* this.streamRequest('/api/pipeline/generate/from-url/stream', {
      gitUrl, provider, model,
      ...(apiKey ? { apiKey } : {}),
      ...(repoToken ? { repoToken } : {}),
    });
  }

  /**
   * Stream AI plugin generation with progressive partial results.
   */
  async *streamPluginGeneration(prompt: string, provider: string, model: string, apiKey?: string) {
    yield* this.streamRequest('/api/plugin/generate/stream', {
      prompt, provider, model, ...(apiKey ? { apiKey } : {}),
    });
  }

  // ============================================
  // Plugin AI generation endpoints
  // ============================================

  async getPluginAIProviders() {
    return this.request<ApiResponse<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>>('/api/plugin/providers');
  }

  async generatePlugin(prompt: string, provider: string, model: string, apiKey?: string) {
    return this.request<ApiResponse<{
      config: {
        name: string;
        description?: string;
        version: string;
        pluginType: string;
        computeType: string;
        keywords: string[];
        primaryOutputDirectory?: string;
        installCommands: string[];
        commands: string[];
        env?: Record<string, string>;
      };
      dockerfile: string;
    }>>('/api/plugin/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt, provider, model, ...(apiKey ? { apiKey } : {}) }),
    });
  }

  async deployGeneratedPlugin(data: {
    name: string;
    description?: string;
    version: string;
    pluginType: string;
    computeType: string;
    keywords?: string[];
    primaryOutputDirectory?: string;
    installCommands: string[];
    commands: string[];
    env?: Record<string, string>;
    dockerfile: string;
    accessModifier: 'public' | 'private';
  }) {
    return this.request<ApiResponse<{
      requestId?: string;
      pluginName?: string;
      imageTag?: string;
    }>>('/api/plugin/deploy-generated', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // ============================================
  // Invitation endpoints
  // ============================================

  async listInvitations() {
    return this.request<ApiResponse<{ invitations: Invitation[] }>>('/api/invitation');
  }

  async getInvitation(token: string) {
    return this.request<ApiResponse<{ invitation: Invitation }>>(`/api/invitation/${token}`);
  }

  async sendInvitation(data: { email: string; role?: 'user' | 'admin'; invitationType?: string }) {
    return this.request<ApiResponse<{ invitation: Invitation }>>('/api/invitation/send', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async acceptInvitation(token: string) {
    return this.request<ApiResponse<{ message: string }>>('/api/invitation/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }

  async revokeInvitation(invitationId: string) {
    return this.request<ApiResponse<{ message: string }>>(`/api/invitation/${invitationId}`, {
      method: 'DELETE',
    });
  }

  async resendInvitation(invitationId: string) {
    return this.request<ApiResponse<{ invitation: Invitation }>>(`/api/invitation/${invitationId}/resend`, {
      method: 'POST',
    });
  }

  // ============================================
  // Log endpoints
  // ============================================

  async getLogs(params?: { service?: string; level?: string; search?: string; start?: string; end?: string; limit?: number; direction?: string }) {
    return this.request<ApiResponse<LogQueryResult>>(`/api/logs${buildQuery(params)}`);
  }

  async getLogServices() {
    return this.request<ApiResponse<{ services: string[] }>>('/api/logs/services');
  }

  async getLogLevels() {
    return this.request<ApiResponse<{ levels: string[] }>>('/api/logs/levels');
  }

  // ============================================
  // Message endpoints
  // ============================================

  /** List inbox messages (root messages only), optionally filtered by type */
  async getMessages(params?: { messageType?: MessageType; limit?: number; offset?: number; sortBy?: string; sortOrder?: string }) {
    return this.request<ApiResponse<{ messages: Message[]; pagination?: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/messages${buildQuery(params)}`);
  }

  /** List announcements only */
  async getAnnouncements() {
    return this.request<ApiResponse<{ messages: Message[] }>>('/api/messages/announcements');
  }

  /** List conversations only */
  async getConversations() {
    return this.request<ApiResponse<{ messages: Message[] }>>('/api/messages/conversations');
  }

  /** Get unread message count */
  async getUnreadCount() {
    return this.request<ApiResponse<{ count: number }>>('/api/messages/unread/count');
  }

  /** Get a single message by ID */
  async getMessage(id: string) {
    return this.request<ApiResponse<{ message: Message }>>(`/api/messages/${id}`);
  }

  /** Get all messages in a thread */
  async getThread(id: string) {
    return this.request<ApiResponse<{ messages: Message[] }>>(`/api/messages/${id}/thread`);
  }

  /** Send a new message (announcement or conversation) */
  async sendMessage(data: {
    recipientOrgId: string;
    messageType: MessageType;
    subject: string;
    content: string;
    priority?: MessagePriority;
  }) {
    return this.request<ApiResponse<Message>>('/api/messages', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /** Reply to a message thread */
  async replyToMessage(id: string, content: string) {
    return this.request<ApiResponse<Message>>(`/api/messages/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  }

  /** Mark a message as read */
  async markMessageAsRead(id: string) {
    return this.request<ApiResponse<{ message: Message }>>(`/api/messages/${id}/read`, {
      method: 'PUT',
    });
  }

  /** Mark all messages in a thread as read */
  async markThreadAsRead(id: string) {
    return this.request<ApiResponse<{ updated: number }>>(`/api/messages/${id}/thread/read`, {
      method: 'PUT',
    });
  }

  /** Delete a message (soft delete) */
  async deleteMessage(id: string) {
    return this.request<ApiResponse<{ message: string }>>(`/api/messages/${id}`, {
      method: 'DELETE',
    });
  }
}

export const api = new ApiClient();
export default api;