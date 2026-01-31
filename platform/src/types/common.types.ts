import { Types } from 'mongoose';

/**
 * User filter for database queries
 */
export interface UserFilter {
  organizationId?: string | Types.ObjectId;
  role?: 'user' | 'admin';
  $or?: Array<{
    username?: { $regex: string; $options: string };
    email?: { $regex: string; $options: string };
  }>;
}

/**
 * Organization filter for database queries
 */
export interface OrganizationFilter {
  _id?: string | Types.ObjectId | { $in: Array<string | Types.ObjectId> };
  name?: string | { $regex: string; $options: string };
  slug?: string;
  owner?: string | Types.ObjectId;
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
  success: true;
  statusCode: number;
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * User update fields
 */
export interface UserUpdateFields {
  username?: string;
  email?: string;
  isEmailVerified?: boolean;
}

/**
 * Organization data for creation
 */
export interface OrganizationCreateData {
  _id?: string;
  name: string;
  owner: Types.ObjectId;
  members: Types.ObjectId[];
  quotas?: {
    plugins: number;
    pipelines: number;
    apiCalls: number;
  };
}

/**
 * Lean user document (from .lean() queries)
 */
export interface LeanUser {
  _id: Types.ObjectId;
  username: string;
  email: string;
  role: 'user' | 'admin';
  isEmailVerified: boolean;
  organizationId?: Types.ObjectId | string;
  tokenVersion?: number;
  password?: string;
  refreshToken?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Lean organization document (from .lean() queries)
 */
export interface LeanOrganization {
  _id: Types.ObjectId | string;
  name: string;
  slug: string;
  description?: string;
  owner: Types.ObjectId;
  members: Types.ObjectId[];
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * HTTP error with status code
 */
export interface HttpError extends Error {
  status?: number;
  statusCode?: number;
  code?: string;
}

/**
 * Registration result
 */
export interface RegistrationResult {
  sub: string;
  email: string;
  role: 'user' | 'admin';
  organizationId: string | null;
  organizationName: string | null;
}

/**
 * User response with organization info
 */
export interface UserWithOrganization {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  isEmailVerified: boolean;
  organizationId: string | null;
  organizationName: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Organization with member info
 */
export interface OrganizationMember {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
}
