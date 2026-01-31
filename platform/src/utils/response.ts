import { Response } from 'express';

/**
 * Standard HTTP status codes used in the API
 */
export const HttpStatus = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

/**
 * Standard error codes for consistent error identification
 */
export const ErrorCode = {
  // Authentication errors
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  SESSION_INVALID: 'SESSION_INVALID',

  // Authorization errors
  FORBIDDEN: 'FORBIDDEN',
  ADMIN_REQUIRED: 'ADMIN_REQUIRED',
  SYSTEM_ADMIN_REQUIRED: 'SYSTEM_ADMIN_REQUIRED',
  ORG_ADMIN_REQUIRED: 'ORG_ADMIN_REQUIRED',
  OWNER_REQUIRED: 'OWNER_REQUIRED',

  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MISSING_FIELDS: 'MISSING_FIELDS',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_FORMAT: 'INVALID_FORMAT',

  // Resource errors
  NOT_FOUND: 'NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  ORG_NOT_FOUND: 'ORG_NOT_FOUND',
  INVITATION_NOT_FOUND: 'INVITATION_NOT_FOUND',
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  PIPELINE_NOT_FOUND: 'PIPELINE_NOT_FOUND',

  // Conflict errors
  CONFLICT: 'CONFLICT',
  DUPLICATE: 'DUPLICATE',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  ALREADY_MEMBER: 'ALREADY_MEMBER',

  // Rate limiting errors
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  ORG_QUOTA_EXCEEDED: 'ORG_QUOTA_EXCEEDED',

  // Operation errors
  OPERATION_FAILED: 'OPERATION_FAILED',
  CANNOT_DELETE_SELF: 'CANNOT_DELETE_SELF',
  CANNOT_MODIFY_OWNER: 'CANNOT_MODIFY_OWNER',
  TRANSFER_REQUIRED: 'TRANSFER_REQUIRED',

  // External service errors
  SERVICE_ERROR: 'SERVICE_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // Server errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

/**
 * Standard error response structure
 */
export interface ErrorResponse {
  success: false;
  statusCode: number;
  message: string;
  code: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Standard success response structure
 */
export interface SuccessResponse<T = unknown> {
  success: true;
  statusCode: number;
  message?: string;
  data: T;
  meta?: ResponseMeta;
  timestamp: string;
}

/**
 * Metadata for paginated responses
 */
export interface ResponseMeta {
  total?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  hasMore?: boolean;
}

/**
 * Generate ISO timestamp
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Send standardized error response
 */
export function sendError(
  res: Response,
  status: number,
  message: string,
  code: string = ErrorCode.INTERNAL_ERROR,
  details?: Record<string, unknown>,
): void {
  const response: ErrorResponse = {
    success: false,
    statusCode: status,
    message,
    code,
    timestamp: getTimestamp(),
  };

  if (details) {
    response.details = details;
  }

  res.status(status).json(response);
}

/**
 * Send 400 Bad Request response
 */
export function sendBadRequest(
  res: Response,
  message: string = 'Bad request',
  code: string = ErrorCode.INVALID_INPUT,
  details?: Record<string, unknown>,
): void {
  sendError(res, HttpStatus.BAD_REQUEST, message, code, details);
}

/**
 * Send 401 Unauthorized response
 */
export function sendUnauthorized(
  res: Response,
  message: string = 'Unauthorized',
  code: string = ErrorCode.UNAUTHORIZED,
): void {
  sendError(res, HttpStatus.UNAUTHORIZED, message, code);
}

/**
 * Send 403 Forbidden response
 */
export function sendForbidden(
  res: Response,
  message: string = 'Forbidden',
  code: string = ErrorCode.FORBIDDEN,
): void {
  sendError(res, HttpStatus.FORBIDDEN, message, code);
}

/**
 * Send 404 Not Found response
 */
export function sendNotFound(
  res: Response,
  message: string = 'Resource not found',
  code: string = ErrorCode.NOT_FOUND,
): void {
  sendError(res, HttpStatus.NOT_FOUND, message, code);
}

/**
 * Send 409 Conflict response
 */
export function sendConflict(
  res: Response,
  message: string = 'Resource already exists',
  code: string = ErrorCode.CONFLICT,
): void {
  sendError(res, HttpStatus.CONFLICT, message, code);
}

/**
 * Send 429 Too Many Requests response
 */
export function sendRateLimited(
  res: Response,
  message: string = 'Too many requests',
  code: string = ErrorCode.RATE_LIMIT_EXCEEDED,
  retryAfter?: number,
): void {
  if (retryAfter) {
    res.setHeader('Retry-After', retryAfter);
  }
  sendError(res, HttpStatus.TOO_MANY_REQUESTS, message, code);
}

/**
 * Send 500 Internal Server Error response
 */
export function sendInternalError(
  res: Response,
  message: string = 'Internal server error',
  code: string = ErrorCode.INTERNAL_ERROR,
): void {
  sendError(res, HttpStatus.INTERNAL_SERVER_ERROR, message, code);
}

/**
 * Send standardized success response
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  status: number = HttpStatus.OK,
  message?: string,
  meta?: ResponseMeta,
): void {
  const response: SuccessResponse<T> = {
    success: true,
    statusCode: status,
    data,
    timestamp: getTimestamp(),
  };

  if (message) {
    response.message = message;
  }

  if (meta) {
    response.meta = meta;
  }

  res.status(status).json(response);
}

/**
 * Send 200 OK response with data
 */
export function sendOk<T>(
  res: Response,
  data: T,
  message?: string,
  meta?: ResponseMeta,
): void {
  sendSuccess(res, data, HttpStatus.OK, message, meta);
}

/**
 * Send 201 Created response
 */
export function sendCreated<T>(
  res: Response,
  data: T,
  message: string = 'Resource created successfully',
): void {
  sendSuccess(res, data, HttpStatus.CREATED, message);
}

/**
 * Send paginated response
 */
export function sendPaginated<T>(
  res: Response,
  items: T[],
  total: number,
  page: number,
  limit: number,
  message?: string,
): void {
  const totalPages = Math.ceil(total / limit);
  sendSuccess(
    res,
    items,
    HttpStatus.OK,
    message,
    {
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    },
  );
}

/**
 * Send message-only success response (for operations like delete)
 */
export function sendMessage(
  res: Response,
  message: string,
  status: number = HttpStatus.OK,
): void {
  sendSuccess(res, { message }, status, message);
}

/**
 * Error mapping for transaction-style error handling
 */
export interface ErrorMapping {
  [key: string]: {
    status: number;
    message: string;
    code: string;
  };
}

/**
 * Handle transaction errors with error mapping
 */
export function handleMappedError(
  res: Response,
  err: Error | unknown,
  errorMap: ErrorMapping,
  defaultMessage: string = 'Operation failed',
  defaultCode: string = ErrorCode.OPERATION_FAILED,
): void {
  const error = err as Error;
  const mapped = errorMap[error.message];

  if (mapped) {
    sendError(res, mapped.status, mapped.message, mapped.code);
  } else {
    sendInternalError(res, defaultMessage, defaultCode);
  }
}

/**
 * Common error mappings for reuse
 */
export const CommonErrorMappings = {
  userNotFound: {
    USER_NOT_FOUND: {
      status: HttpStatus.NOT_FOUND,
      message: 'User not found',
      code: ErrorCode.USER_NOT_FOUND,
    },
  },
  orgNotFound: {
    ORG_NOT_FOUND: {
      status: HttpStatus.NOT_FOUND,
      message: 'Organization not found',
      code: ErrorCode.ORG_NOT_FOUND,
    },
  },
  invitationNotFound: {
    INVITATION_NOT_FOUND: {
      status: HttpStatus.NOT_FOUND,
      message: 'Invitation not found',
      code: ErrorCode.INVITATION_NOT_FOUND,
    },
  },
  memberOperations: {
    ORG_NOT_FOUND: {
      status: HttpStatus.NOT_FOUND,
      message: 'Organization not found',
      code: ErrorCode.ORG_NOT_FOUND,
    },
    USER_NOT_FOUND: {
      status: HttpStatus.NOT_FOUND,
      message: 'User not found',
      code: ErrorCode.USER_NOT_FOUND,
    },
    NOT_A_MEMBER: {
      status: HttpStatus.BAD_REQUEST,
      message: 'User is not a member of this organization',
      code: ErrorCode.INVALID_INPUT,
    },
    CANNOT_REMOVE_OWNER: {
      status: HttpStatus.BAD_REQUEST,
      message: 'Cannot remove organization owner. Transfer ownership first.',
      code: ErrorCode.CANNOT_MODIFY_OWNER,
    },
    NEW_OWNER_MUST_BE_MEMBER: {
      status: HttpStatus.BAD_REQUEST,
      message: 'New owner must be a member of the organization',
      code: ErrorCode.INVALID_INPUT,
    },
    ALREADY_MEMBER: {
      status: HttpStatus.CONFLICT,
      message: 'User is already a member of this organization',
      code: ErrorCode.ALREADY_MEMBER,
    },
  },
  invitationOperations: {
    ORGANIZATION_NOT_FOUND: {
      status: HttpStatus.NOT_FOUND,
      message: 'Organization not found',
      code: ErrorCode.ORG_NOT_FOUND,
    },
    UNAUTHORIZED: {
      status: HttpStatus.FORBIDDEN,
      message: 'You do not have permission to send invitations',
      code: ErrorCode.FORBIDDEN,
    },
    ALREADY_MEMBER: {
      status: HttpStatus.CONFLICT,
      message: 'User is already a member of this organization',
      code: ErrorCode.ALREADY_MEMBER,
    },
    INVITATION_ALREADY_SENT: {
      status: HttpStatus.CONFLICT,
      message: 'An invitation has already been sent to this email',
      code: ErrorCode.ALREADY_EXISTS,
    },
    MAX_INVITATIONS_REACHED: {
      status: HttpStatus.BAD_REQUEST,
      message: 'Maximum pending invitations limit reached',
      code: ErrorCode.QUOTA_EXCEEDED,
    },
    INVITATION_EXPIRED: {
      status: HttpStatus.BAD_REQUEST,
      message: 'This invitation has expired',
      code: ErrorCode.TOKEN_EXPIRED,
    },
    INVITATION_INVALID: {
      status: HttpStatus.BAD_REQUEST,
      message: 'This invitation is no longer valid',
      code: ErrorCode.TOKEN_INVALID,
    },
  },
} as const;
