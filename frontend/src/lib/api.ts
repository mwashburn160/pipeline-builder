import { AuthTokens, ApiResponse } from '@/types';

// Use relative URL in browser (requests go through nginx), absolute URL for SSR
const API_URL = typeof window !== 'undefined' ? '' : (process.env.PLATFORM_BASE_URL || 'http://localhost:8443');

// Custom error class with statusCode
export class ApiError extends Error {
  statusCode: number;
  code?: string;
  
  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private organizationId: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem('accessToken');
      this.refreshToken = localStorage.getItem('refreshToken');
      this.organizationId = localStorage.getItem('organizationId');
    }
  }

  setTokens(tokens: AuthTokens) {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    if (typeof window !== 'undefined') {
      localStorage.setItem('accessToken', tokens.accessToken);
      localStorage.setItem('refreshToken', tokens.refreshToken);
      
      // Extract organizationId from JWT token if present
      try {
        const payload = JSON.parse(atob(tokens.accessToken.split('.')[1]));
        console.log('[API] JWT payload:', payload);
        if (payload.organizationId) {
          this.organizationId = payload.organizationId;
          localStorage.setItem('organizationId', payload.organizationId);
        }
      } catch (e) {
        console.error('[API] Failed to parse JWT:', e);
      }
    }
  }

  setOrganizationId(orgId: string) {
    this.organizationId = orgId;
    if (typeof window !== 'undefined') {
      localStorage.setItem('organizationId', orgId);
    }
  }

  getOrganizationId() {
    return this.organizationId;
  }

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

  getAccessToken() {
    return this.accessToken;
  }

  isAuthenticated() {
    return !!this.accessToken;
  }

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

    console.log(`[API] ${options.method || 'GET'} ${endpoint}`);

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'same-origin',
    });

    // Parse JSON response
    const data = await response.json().catch(() => ({ statusCode: response.status, message: 'Request failed' }));
    const statusCode = data.statusCode || response.status;
    
    console.log(`[API] ${options.method || 'GET'} ${endpoint} -> ${statusCode}`);

    // Handle 401 - try to refresh token
    if (statusCode === 401 && this.refreshToken) {
      console.log('[API] Token expired, attempting refresh...');
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${this.accessToken}`;
        const retryResponse = await fetch(url, {
          ...options,
          headers,
          credentials: 'same-origin',
        });
        const retryData = await retryResponse.json().catch(() => ({ statusCode: retryResponse.status, message: 'Request failed' }));
        const retryStatusCode = retryData.statusCode || retryResponse.status;
        console.log(`[API] Retry ${endpoint} -> ${retryStatusCode}`);
        
        if (retryStatusCode >= 400) {
          throw new ApiError(retryData.message || retryData.error || 'Request failed', retryStatusCode, retryData.code);
        }
        return retryData;
      }
    }

    // Check statusCode from response body
    if (statusCode >= 400) {
      console.error(`[API] Error ${endpoint}:`, data);
      throw new ApiError(data.message || data.error || 'Request failed', statusCode, data.code);
    }

    return data;
  }

  private async refreshAccessToken(): Promise<boolean> {
    try {
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      const data = await response.json().catch(() => ({ statusCode: response.status }));
      const statusCode = data.statusCode || response.status;
      
      if (statusCode < 400 && data.accessToken) {
        this.setTokens(data);
        return true;
      }
    } catch {
      // Refresh failed
    }
    this.clearTokens();
    return false;
  }

  // Auth endpoints
  async login(email: string, password: string) {
    console.log('[API] Login attempt');
    const data = await this.request<{ success: boolean; statusCode: number; accessToken?: string; refreshToken?: string; user?: unknown; message?: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: email, password }),
    });
    
    // Check statusCode for success (2xx)
    if (data.statusCode < 400 && data.accessToken && data.refreshToken) {
      this.setTokens({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      });
    }
    return { success: data.statusCode < 400, statusCode: data.statusCode, data: { user: data.user }, message: data.message };
  }

  async register(username: string, email: string, password: string) {
    return this.request<ApiResponse<unknown>>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
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
    return this.request<ApiResponse<unknown>>('/api/user/profile');
  }

  // Organization endpoints
  async getOrganizations() {
    return this.request<ApiResponse<unknown>>('/api/organization/');
  }

  async listOrganizations() {
    return this.request<ApiResponse<unknown>>('/api/organizations');
  }

  async createOrganization(name: string, description?: string) {
    return this.request<ApiResponse<unknown>>('/api/organization/', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    });
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

  async getOrganizationQuotas(id: string) {
    return this.request<ApiResponse<unknown>>(`/api/organization/${id}/quotas`);
  }

  async updateOrganizationQuotas(id: string, data: { plugins?: number; pipelines?: number; apiCalls?: number }) {
    return this.request<ApiResponse<unknown>>(`/api/organization/${id}/quotas`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // Plugin endpoints
  async getPlugin(idOrParams?: string | Record<string, string>) {
    if (typeof idOrParams === 'string') {
      // Get by ID
      return this.request<ApiResponse<unknown>>(`/api/plugin/${idOrParams}`);
    }
    // Get with filters (or list all)
    const query = idOrParams ? '?' + new URLSearchParams(idOrParams).toString() : '';
    return this.request<ApiResponse<unknown>>(`/api/plugin${query}`);
  }

  async listPlugins(params?: Record<string, string>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request<ApiResponse<unknown>>(`/api/plugins${query}`);
  }

  async uploadPlugin(file: File, accessModifier: 'public' | 'private' = 'private') {
    const formData = new FormData();
    formData.append('plugin', file);
    formData.append('accessModifier', accessModifier);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
    };

    if (this.organizationId) {
      headers['x-org-id'] = this.organizationId;
    }

    const response = await fetch(`${API_URL}/api/plugin/upload`, {
      method: 'POST',
      headers,
      body: formData,
    });

    const data = await response.json().catch(() => ({ statusCode: response.status, message: 'Upload failed' }));
    const statusCode = data.statusCode || response.status;

    if (statusCode >= 400) {
      throw new ApiError(data.message || data.error || 'Upload failed', statusCode, data.code);
    }

    return data;
  }

  // Pipeline endpoints
  async getPipeline(idOrParams?: string | Record<string, string>) {
    if (typeof idOrParams === 'string') {
      // Get by ID
      return this.request<ApiResponse<unknown>>(`/api/pipeline/${idOrParams}`);
    }
    // Get with filters (or list all)
    const query = idOrParams ? '?' + new URLSearchParams(idOrParams).toString() : '';
    return this.request<ApiResponse<unknown>>(`/api/pipeline${query}`);
  }

  async listPipelines(params?: Record<string, string>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request<ApiResponse<unknown>>(`/api/pipelines${query}`);
  }

  async createPipeline(data: { project: string; organization: string; props: Record<string, unknown>; accessModifier?: string }) {
    return this.request<ApiResponse<unknown>>('/api/pipeline', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Invitation endpoints
  async getInvitations() {
    return this.request<ApiResponse<unknown>>('/api/organization/invitations');
  }

  async createInvitation(email: string, role: 'user' | 'admin' = 'user') {
    return this.request<ApiResponse<unknown>>('/api/organization/invitation', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
  }

  async acceptInvitation(token: string) {
    return this.request<ApiResponse<unknown>>(`/api/organization/invitation/accept/${token}`, {
      method: 'POST',
    });
  }

  async cancelInvitation(id: string) {
    return this.request<ApiResponse<unknown>>(`/api/organization/invitation/${id}`, {
      method: 'DELETE',
    });
  }

  // Quota endpoints
  async getQuotas() {
    return this.request<ApiResponse<unknown>>('/api/organization/quotas');
  }

  // User management endpoints (System Admin / Org Admin)
  async listUsers(params?: { organizationId?: string; role?: string; search?: string; page?: number; limit?: number }) {
    const query = params ? '?' + new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    ).toString() : '';
    return this.request<ApiResponse<unknown>>(`/api/users${query}`);
  }

  async getUserById(id: string) {
    return this.request<ApiResponse<unknown>>(`/api/users/${id}`);
  }

  async updateUserById(id: string, data: { username?: string; email?: string; role?: string; organizationId?: string | null }) {
    return this.request<ApiResponse<unknown>>(`/api/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteUserById(id: string) {
    return this.request<ApiResponse<unknown>>(`/api/users/${id}`, {
      method: 'DELETE',
    });
  }

  // Organization member endpoints
  async getOrganizationMembers(orgId: string) {
    return this.request<ApiResponse<unknown>>(`/api/organization/${orgId}/members`);
  }

  async addMemberToOrganization(orgId: string, data: { userId?: string; email?: string }) {
    return this.request<ApiResponse<unknown>>(`/api/organization/${orgId}/members`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async removeMemberFromOrganization(orgId: string, userId: string) {
    return this.request<ApiResponse<unknown>>(`/api/organization/${orgId}/members/${userId}`, {
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
    return this.request<ApiResponse<unknown>>(`/api/organization/${orgId}/transfer-owner`, {
      method: 'PATCH',
      body: JSON.stringify({ newOwnerId }),
    });
  }

  async deleteOrganization(orgId: string) {
    return this.request<ApiResponse<unknown>>(`/api/organization/${orgId}`, {
      method: 'DELETE',
    });
  }
}

export const api = new ApiClient();
export default api;
