import { AuthTokens, ApiResponse, PaginatedResponse, CreatePipelineData, BuilderProps } from '@/types';

// Use relative URL in browser (requests go through nginx), absolute URL for SSR
const API_URL = typeof window !== 'undefined' ? '' : (process.env.PLATFORM_BASE_URL || 'http://localhost:8443');

/**
 * Check if we're in development mode
 */
const isDev = process.env.NODE_ENV === 'development';

/**
 * Development-only logger
 */
const devLog = (...args: unknown[]) => {
  if (isDev) {
    console.log('[API]', ...args);
  }
};

/**
 * Custom error class for API errors
 */
export class ApiError extends Error {
  statusCode: number;
  code?: string;
  details?: Record<string, unknown>;
  
  constructor(message: string, statusCode: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  /**
   * Check if error is a specific type
   */
  is(code: string): boolean {
    return this.code === code;
  }

  /**
   * Check if error is unauthorized
   */
  isUnauthorized(): boolean {
    return this.statusCode === 401;
  }

  /**
   * Check if error is forbidden
   */
  isForbidden(): boolean {
    return this.statusCode === 403;
  }

  /**
   * Check if error is not found
   */
  isNotFound(): boolean {
    return this.statusCode === 404;
  }

  /**
   * Check if error is rate limited
   */
  isRateLimited(): boolean {
    return this.statusCode === 429;
  }
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

  constructor() {
    if (typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem('accessToken');
      this.refreshToken = localStorage.getItem('refreshToken');
      this.organizationId = localStorage.getItem('organizationId');
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
        const payload = JSON.parse(atob(tokens.accessToken.split('.')[1]));
        if (payload.organizationId) {
          this.organizationId = payload.organizationId;
          localStorage.setItem('organizationId', payload.organizationId);
        }
      } catch {
        // JWT parsing failed - non-critical
      }
    }
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

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    return !!this.accessToken;
  }

  /**
   * Make an API request
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${API_URL}${endpoint}`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    if (this.organizationId) {
      headers['x-org-id'] = this.organizationId;
    }

    devLog(`${options.method || 'GET'} ${endpoint}`);

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'same-origin',
    });

    // Parse JSON response
    const data = await response.json().catch(() => ({ 
      statusCode: response.status, 
      message: 'Request failed',
      success: false,
    }));
    
    const statusCode = data.statusCode || response.status;
    
    devLog(`${options.method || 'GET'} ${endpoint} -> ${statusCode}`);

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
        devLog(`Retry ${endpoint} -> ${retryStatusCode}`);
        
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

    // Check statusCode from response body
    if (statusCode >= 400) {
      throw new ApiError(
        data.message || 'Request failed',
        statusCode,
        data.code,
        data.details
      );
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
        this.setTokens(tokens);
        return true;
      }
    } catch {
      // Refresh failed
    }
    
    this.clearTokens();
    return false;
  }

  // ============================================
  // Auth endpoints
  // ============================================

  async login(email: string, password: string) {
    devLog('Login attempt');
    
    const response = await this.request<ApiResponse<{ accessToken: string; refreshToken: string }>>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: email, password }),
    });
    
    // Extract tokens from data wrapper (standardized format)
    const tokens = response.data;
    
    if (response.success && tokens?.accessToken && tokens?.refreshToken) {
      this.setTokens({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    }
    
    return response;
  }

  async register(username: string, email: string, password: string, organizationName?: string) {
    return this.request<ApiResponse<{ user: unknown }>>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, organizationName }),
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
    return this.request<ApiResponse<{ user: unknown }>>('/api/user/profile');
  }

  async updateProfile(data: { username?: string; email?: string }) {
    return this.request<ApiResponse<{ user: unknown }>>('/api/user/profile', {
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
    const response = await this.request<{ success: boolean; statusCode: number; accessToken: string; refreshToken: string }>(
      '/api/user/generate-token',
      { method: 'POST' },
    );

    if (response.success && response.accessToken && response.refreshToken) {
      this.setTokens({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
      });
    }

    return response;
  }

  /**
   * Get the current raw access token string
   */
  getRawAccessToken(): string | null {
    return this.accessToken;
  }

  /**
   * Get the current raw refresh token string
   */
  getRawRefreshToken(): string | null {
    return this.refreshToken;
  }

  // ============================================
  // Organization endpoints
  // ============================================

  async getMyOrganization() {
    return this.request<ApiResponse<unknown>>('/api/organization');
  }

  async listOrganizations() {
    return this.request<ApiResponse<{ organizations: unknown[] }>>('/api/organizations');
  }

  async getOrganization(id: string) {
    return this.request<ApiResponse<unknown>>(`/api/organization/${id}`);
  }

  async updateOrganization(id: string, data: { name?: string; description?: string }) {
    return this.request<ApiResponse<unknown>>(`/api/organization/${id}`, {
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
    return this.request<ApiResponse<{ members: unknown[] }>>(`/api/organization/${orgId}/members`);
  }

  async addMemberToOrganization(orgId: string, data: { userId?: string; email?: string }) {
    return this.request<ApiResponse<unknown>>(`/api/organization/${orgId}/members`, {
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
    return this.request<ApiResponse<unknown>>(`/api/organization/${orgId}/members/${userId}`, {
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

  // ============================================
  // User management endpoints (Admin)
  // ============================================

  async listUsers(params?: { organizationId?: string; role?: string; search?: string; page?: number; limit?: number }) {
    const query = params ? '?' + new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    ).toString() : '';
    return this.request<PaginatedResponse<unknown>>(`/api/users${query}`);
  }

  async getUserById(id: string) {
    return this.request<ApiResponse<{ user: unknown }>>(`/api/users/${id}`);
  }

  async updateUserById(id: string, data: { username?: string; email?: string; role?: string; organizationId?: string | null; password?: string }) {
    return this.request<ApiResponse<{ user: unknown }>>(`/api/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteUserById(id: string) {
    return this.request<ApiResponse<{ message: string }>>(`/api/users/${id}`, {
      method: 'DELETE',
    });
  }

  // ============================================
  // Quota endpoints (quota service — nginx proxies /api/quota → quota:3000/quotas)
  // ============================================

  /** Get quotas for the requesting user's org (from JWT). */
  async getOwnQuotas() {
    return this.request<ApiResponse<{ quota: unknown }>>('/api/quota');
  }

  /** Get all orgs with quotas (system admin only). */
  async getAllOrgQuotas() {
    return this.request<ApiResponse<{ organizations: unknown[]; total: number }>>('/api/quota/all');
  }

  /** Get quotas for a specific org. */
  async getOrgQuotas(orgId: string) {
    return this.request<ApiResponse<{ quota: unknown }>>(`/api/quota/${orgId}`);
  }

  /** Update org name, slug, and/or quotas (system admin only). */
  async updateOrgQuotas(orgId: string, data: { name?: string; slug?: string; quotas?: Record<string, number> }) {
    return this.request<ApiResponse<{ quota: unknown }>>(`/api/quota/${orgId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** Reset usage counters (system admin only). */
  async resetOrgQuotaUsage(orgId: string, quotaType?: string) {
    return this.request<ApiResponse<{ quota: unknown }>>(`/api/quota/${orgId}/reset`, {
      method: 'POST',
      body: JSON.stringify(quotaType ? { quotaType } : {}),
    });
  }

  // ============================================
  // Plugin endpoints
  // ============================================

  async listPlugins(params?: Record<string, string>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request<PaginatedResponse<unknown>>(`/api/plugins${query}`);
  }

  async getPluginById(id: string) {
    return this.request<ApiResponse<{ plugin: unknown }>>(`/api/plugin/${id}`);
  }

  async searchPlugins(params: Record<string, string>) {
    const query = '?' + new URLSearchParams(params).toString();
    return this.request<ApiResponse<{ plugin: unknown }>>(`/api/plugin/search${query}`);
  }

  async uploadPlugin(file: File, accessModifier: 'public' | 'private' = 'private') {
    const formData = new FormData();
    formData.append('plugin', file);
    formData.append('accessModifier', accessModifier);

    const headers: Record<string, string> = {};
    
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    if (this.organizationId) {
      headers['x-org-id'] = this.organizationId;
    }

    const response = await fetch(`${API_URL}/api/plugin/upload`, {
      method: 'POST',
      headers,
      body: formData,
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

    return data as ApiResponse<{ plugin: unknown; warning?: string }>;
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
  }) {
    return this.request<ApiResponse<{ plugin: unknown }>>(`/api/plugin/${id}`, {
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
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request<PaginatedResponse<unknown>>(`/api/pipelines${query}`);
  }

  async getPipelineById(id: string) {
    return this.request<ApiResponse<{ pipeline: unknown }>>(`/api/pipeline/${id}`);
  }

  async searchPipelines(params: Record<string, string>) {
    const query = '?' + new URLSearchParams(params).toString();
    return this.request<ApiResponse<{ pipeline: unknown }>>(`/api/pipeline/search${query}`);
  }

  async createPipeline(data: CreatePipelineData) {
    return this.request<ApiResponse<{ pipeline: unknown; warning?: string }>>('/api/pipeline', {
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
    return this.request<ApiResponse<{ pipeline: unknown }>>(`/api/pipeline/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deletePipeline(id: string) {
    return this.request<ApiResponse<{ message: string }>>(`/api/pipeline/${id}`, {
      method: 'DELETE',
    });
  }

  // ============================================
  // Invitation endpoints
  // ============================================

  async listInvitations() {
    return this.request<ApiResponse<{ invitations: unknown[] }>>('/api/invitation');
  }

  async getInvitation(token: string) {
    return this.request<ApiResponse<{ invitation: unknown }>>(`/api/invitation/${token}`);
  }

  async sendInvitation(data: { email: string; role?: 'user' | 'admin'; invitationType?: string }) {
    return this.request<ApiResponse<{ invitation: unknown }>>('/api/invitation/send', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async acceptInvitation(token: string) {
    return this.request<ApiResponse<unknown>>('/api/invitation/accept', {
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
    return this.request<ApiResponse<{ invitation: unknown }>>(`/api/invitation/${invitationId}/resend`, {
      method: 'POST',
    });
  }
}

export const api = new ApiClient();
export default api;