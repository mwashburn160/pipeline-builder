export interface User {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  organizationId?: string;
  organizationName?: string;
  isEmailVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMember {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  isOwner: boolean;
  isEmailVerified: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface QuotaInfo {
  used: number;
  limit: number | 'unlimited';
  remaining: number | 'unlimited';
  resetAt: string;
  resetPeriod: string;
  unlimited: boolean;
}

export interface OrganizationQuotas {
  plugins: QuotaInfo;
  pipelines: QuotaInfo;
  apiCalls: QuotaInfo;
}

export interface Organization {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  ownerId: string;
  memberCount: number;
  quotas?: OrganizationQuotas;
  createdAt: string;
  updatedAt: string;
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  pluginType: string;
  computeType: string;
  imageTag: string;
  fullImage: string;
  isActive: boolean;
  isDefault: boolean;
  accessModifier: 'public' | 'private';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pipeline {
  id: string;
  project: string;
  organization: string;
  pipelineName: string;
  props: Record<string, unknown>;
  isActive: boolean;
  isDefault: boolean;
  accessModifier: 'public' | 'private';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: 'user' | 'admin';
  status: 'pending' | 'accepted' | 'expired' | 'cancelled';
  invitedBy: string;
  inviterName: string;
  organizationId: string;
  organizationName: string;
  expiresAt: string;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface ApiResponse<T> {
  success: boolean;
  statusCode: number;
  data?: T;
  message?: string;
  error?: string;
  code?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  statusCode: number;
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
