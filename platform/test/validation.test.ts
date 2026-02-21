// ---------------------------------------------------------------------------
// Mock config before importing schemas that depend on it
// ---------------------------------------------------------------------------
jest.mock('../src/config', () => ({
  config: {
    auth: { passwordMinLength: 8 },
  },
}));

import {
  emailSchema,
  registerSchema,
  loginSchema,
  refreshSchema,
  oauthCallbackSchema,
  updateProfileSchema,
  changePasswordSchema,
  sendInvitationSchema,
  updateOrganizationSchema,
  addMemberSchema,
  updateMemberRoleSchema,
  transferOwnershipSchema,
  updateQuotasSchema,
  validateBody,
} from '../src/utils/validation';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emailSchema', () => {
  it('should accept valid emails', () => {
    expect(emailSchema.safeParse('user@example.com').success).toBe(true);
    expect(emailSchema.safeParse('admin@internal').success).toBe(true);
  });

  it('should reject invalid emails', () => {
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
    expect(emailSchema.safeParse('').success).toBe(false);
    expect(emailSchema.safeParse('user @domain.com').success).toBe(false);
  });
});

describe('registerSchema', () => {
  const valid = {
    username: 'testuser',
    email: 'test@example.com',
    password: 'Password1',
  };

  it('should accept valid registration', () => {
    expect(registerSchema.safeParse(valid).success).toBe(true);
  });

  it('should accept optional organizationName', () => {
    expect(registerSchema.safeParse({ ...valid, organizationName: 'My Org' }).success).toBe(true);
  });

  it('should reject short username', () => {
    expect(registerSchema.safeParse({ ...valid, username: 'a' }).success).toBe(false);
  });

  it('should reject invalid username characters', () => {
    expect(registerSchema.safeParse({ ...valid, username: 'test user!' }).success).toBe(false);
  });

  it('should reject short password', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'Ab1' }).success).toBe(false);
  });

  it('should reject password without uppercase', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'password1' }).success).toBe(false);
  });

  it('should reject password without lowercase', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'PASSWORD1' }).success).toBe(false);
  });

  it('should reject password without digit', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'Passwordd' }).success).toBe(false);
  });

  it('should reject invalid email', () => {
    expect(registerSchema.safeParse({ ...valid, email: 'bad' }).success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('should accept valid login', () => {
    expect(loginSchema.safeParse({ identifier: 'user@test.com', password: 'pass' }).success).toBe(true);
  });

  it('should reject empty identifier', () => {
    expect(loginSchema.safeParse({ identifier: '', password: 'pass' }).success).toBe(false);
  });

  it('should reject empty password', () => {
    expect(loginSchema.safeParse({ identifier: 'user', password: '' }).success).toBe(false);
  });
});

describe('refreshSchema', () => {
  it('should accept valid refresh token', () => {
    expect(refreshSchema.safeParse({ refreshToken: 'some-token-value' }).success).toBe(true);
  });

  it('should reject empty refresh token', () => {
    expect(refreshSchema.safeParse({ refreshToken: '' }).success).toBe(false);
  });

  it('should reject missing refresh token', () => {
    expect(refreshSchema.safeParse({}).success).toBe(false);
  });
});

describe('oauthCallbackSchema', () => {
  it('should accept valid callback data', () => {
    expect(oauthCallbackSchema.safeParse({ code: 'auth-code', state: 'random-state' }).success).toBe(true);
  });

  it('should reject missing code', () => {
    expect(oauthCallbackSchema.safeParse({ state: 'state' }).success).toBe(false);
  });

  it('should reject empty code', () => {
    expect(oauthCallbackSchema.safeParse({ code: '', state: 'state' }).success).toBe(false);
  });

  it('should reject missing state', () => {
    expect(oauthCallbackSchema.safeParse({ code: 'code' }).success).toBe(false);
  });
});

describe('updateProfileSchema', () => {
  it('should accept username update', () => {
    expect(updateProfileSchema.safeParse({ username: 'newname' }).success).toBe(true);
  });

  it('should accept email update', () => {
    expect(updateProfileSchema.safeParse({ email: 'new@email.com' }).success).toBe(true);
  });

  it('should reject empty body', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });

  it('should reject short username', () => {
    expect(updateProfileSchema.safeParse({ username: 'a' }).success).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  it('should accept valid password change', () => {
    expect(changePasswordSchema.safeParse({
      currentPassword: 'old-pass',
      newPassword: 'NewPass99',
    }).success).toBe(true);
  });

  it('should reject empty current password', () => {
    expect(changePasswordSchema.safeParse({
      currentPassword: '',
      newPassword: 'NewPass99',
    }).success).toBe(false);
  });

  it('should reject short new password', () => {
    expect(changePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword: 'Ab1',
    }).success).toBe(false);
  });
});

describe('sendInvitationSchema', () => {
  it('should accept valid invitation', () => {
    expect(sendInvitationSchema.safeParse({ email: 'invite@test.com' }).success).toBe(true);
  });

  it('should default role to user', () => {
    const result = sendInvitationSchema.safeParse({ email: 'invite@test.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe('user');
    }
  });

  it('should accept admin role', () => {
    expect(sendInvitationSchema.safeParse({ email: 'a@b.com', role: 'admin' }).success).toBe(true);
  });

  it('should accept invitation type', () => {
    expect(sendInvitationSchema.safeParse({
      email: 'a@b.com',
      invitationType: 'oauth',
      allowedOAuthProviders: ['google'],
    }).success).toBe(true);
  });

  it('should reject invalid email', () => {
    expect(sendInvitationSchema.safeParse({ email: 'not-email' }).success).toBe(false);
  });
});

describe('updateOrganizationSchema', () => {
  it('should accept name update', () => {
    expect(updateOrganizationSchema.safeParse({ name: 'New Org Name' }).success).toBe(true);
  });

  it('should accept description update', () => {
    expect(updateOrganizationSchema.safeParse({ description: 'A description' }).success).toBe(true);
  });

  it('should accept empty body', () => {
    expect(updateOrganizationSchema.safeParse({}).success).toBe(true);
  });

  it('should reject short name', () => {
    expect(updateOrganizationSchema.safeParse({ name: 'A' }).success).toBe(false);
  });
});

describe('addMemberSchema', () => {
  it('should accept userId', () => {
    expect(addMemberSchema.safeParse({ userId: 'user-123' }).success).toBe(true);
  });

  it('should accept email', () => {
    expect(addMemberSchema.safeParse({ email: 'member@org.com' }).success).toBe(true);
  });

  it('should reject empty body (neither userId nor email)', () => {
    expect(addMemberSchema.safeParse({}).success).toBe(false);
  });
});

describe('updateMemberRoleSchema', () => {
  it('should accept valid roles', () => {
    expect(updateMemberRoleSchema.safeParse({ role: 'user' }).success).toBe(true);
    expect(updateMemberRoleSchema.safeParse({ role: 'admin' }).success).toBe(true);
  });

  it('should reject invalid role', () => {
    expect(updateMemberRoleSchema.safeParse({ role: 'superadmin' }).success).toBe(false);
  });
});

describe('transferOwnershipSchema', () => {
  it('should accept valid newOwnerId', () => {
    expect(transferOwnershipSchema.safeParse({ newOwnerId: 'user-456' }).success).toBe(true);
  });

  it('should reject empty newOwnerId', () => {
    expect(transferOwnershipSchema.safeParse({ newOwnerId: '' }).success).toBe(false);
  });
});

describe('updateQuotasSchema', () => {
  it('should accept numeric quota values', () => {
    expect(updateQuotasSchema.safeParse({ plugins: 100, pipelines: 50 }).success).toBe(true);
  });

  it('should accept unlimited string', () => {
    expect(updateQuotasSchema.safeParse({ plugins: 'unlimited' }).success).toBe(true);
  });

  it('should accept -1 for unlimited', () => {
    expect(updateQuotasSchema.safeParse({ apiCalls: -1 }).success).toBe(true);
  });

  it('should accept empty object', () => {
    expect(updateQuotasSchema.safeParse({}).success).toBe(true);
  });

  it('should reject non-integer numbers', () => {
    expect(updateQuotasSchema.safeParse({ plugins: 1.5 }).success).toBe(false);
  });

  it('should reject values below -1', () => {
    expect(updateQuotasSchema.safeParse({ pipelines: -5 }).success).toBe(false);
  });
});

describe('validateBody', () => {
  it('should return parsed data on valid input', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const result = validateBody(loginSchema, { identifier: 'user', password: 'pass' }, res);
    expect(result).toEqual({ identifier: 'user', password: 'pass' });
  });

  it('should return null and send error on invalid input', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
    const result = validateBody(loginSchema, {}, res);
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
