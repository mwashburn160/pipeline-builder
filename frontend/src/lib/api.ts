import { AuthTokens, ApiResponse } from '@/types';

const API_URL = process.env.PLATFORM_URL || 'https://localhost:8443';

class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.accessToken = localStorage.getItem('accessToken');
      this.refreshToken = localStorage.getItem('refreshToken');
    }
  }

  setTokens(tokens: AuthTokens) {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    if (typeof window !== 'undefined') {
      localStorage.setItem('accessToken', tokens.accessToken);
      localStorage.setItem('refreshToken', tokens.refreshToken);
    }
  }

  clearTokens() {
    this.accessToken = null;
    this.refreshToken = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
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

    // Log request
    console.log(`[API] ${options.method || 'GET'} ${endpoint}`, {
      body: options.body ? JSON.parse(options.body as string) : undefined,
    });

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    });

    // Log response status
    console.log(`[API] ${options.method || 'GET'} ${endpoint} -> ${response.status}`);

    // Handle 401 - try to refresh token
    if (response.status === 401 && this.refreshToken) {
      console.log('[API] Token expired, attempting refresh...');
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${this.accessToken}`;
        const retryResponse = await fetch(url, {
          ...options,
          headers,
          credentials: 'include',
        });
        const data = await retryResponse.json();
        console.log(`[API] Retry ${endpoint} -> ${retryResponse.status}`, data);
        return data;
      }
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Request failed' }));
      console.error(`[API] Error ${endpoint}:`, error);
      throw new Error(error.message || error.error || 'Request failed');
    }

    const data = await response.json();
    console.log(`[API] Response ${endpoint}:`, data);
    return data;
  }

  private async refreshAccessToken(): Promise<boolean> {
    try {
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      if (response.ok) {
        const data = await response.json();
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
    const data = await this.request<ApiResponse<AuthTokens & { user: unknown }>>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: email, password }),
    });
    if (data.data) {
      this.setTokens({
        accessToken: data.data.accessToken,
        refreshToken: data.data.refreshToken,
      });
    }
    return data;
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
    return this.request<ApiResponse<unknown>>('/api/organization');
  }

  async createOrganization(name: string, description?: string) {
    return this.request<ApiResponse<unknown>>('/api/organization', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    });
  }

  async getOrganization(id: string) {
    return this.request<ApiResponse<unknown>>(`/api/organization/${id}`);
  }

  // Plugin endpoints
  async getPlugins(params?: Record<string, string>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request<ApiResponse<unknown>>(`/api/plugins${query}`);
  }

  async getPlugin(id: string) {
    return this.request<ApiResponse<unknown>>(`/api/plugin/${id}`);
  }

  async uploadPlugin(file: File, accessModifier: 'public' | 'private' = 'private') {
    const formData = new FormData();
    formData.append('plugin', file);
    formData.append('accessModifier', accessModifier);

    const response = await fetch(`${API_URL}/api/plugin/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Upload failed' }));
      throw new Error(error.message || 'Upload failed');
    }

    return response.json();
  }

  // Pipeline endpoints
  async getPipelines(params?: Record<string, string>) {
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    return this.request<ApiResponse<unknown>>(`/api/pipelines${query}`);
  }

  async getPipeline(id: string) {
    return this.request<ApiResponse<unknown>>(`/api/pipeline/${id}`);
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
}

export const api = new ApiClient();
export default api;
