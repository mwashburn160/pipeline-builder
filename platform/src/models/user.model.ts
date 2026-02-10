import bcrypt from 'bcryptjs';
import mongoose, { Schema, Document, Types } from 'mongoose';
import { config } from '../config';

/**
 * OAuth provider data structure
 */
export interface OAuthProviderData {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  linkedAt: Date;
}

/**
 * OAuth providers map
 */
export interface OAuthProviders {
  google?: OAuthProviderData;
}

/**
 * User document interface
 */
export interface IUser extends Document {
  _id: Types.ObjectId;
  username: string;
  email: string;
  password?: string;
  role: 'user' | 'admin';
  organizationId?: Types.ObjectId | string;
  isEmailVerified: boolean;
  tokenVersion: number;
  refreshToken?: string;
  oauth?: OAuthProviders;
  comparePassword(password: string): Promise<boolean>;
  invalidateAllSessions(): Promise<IUser>;
  hasOAuthProvider(provider: keyof OAuthProviders): boolean;
  getLinkedProviders(): string[];
}

const oauthProviderSchema = new Schema<OAuthProviderData>(
  {
    id: { type: String, required: true },
    email: { type: String, required: true },
    name: { type: String },
    picture: { type: String },
    linkedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      select: false,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    organizationId: {
      type: Schema.Types.Mixed,
      ref: 'Organization',
      index: true,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    tokenVersion: {
      type: Number,
      default: 0,
    },
    refreshToken: {
      type: String,
      select: false,
    },
    oauth: {
      google: oauthProviderSchema,
    },
  },
  { timestamps: true },
);

/**
 * Validate password strength: min 8 chars, at least one uppercase, one lowercase, one digit.
 */
function validatePasswordStrength(password: string): string | null {
  if (password.length < config.auth.passwordMinLength) return `Password must be at least ${config.auth.passwordMinLength} characters`;
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one digit';
  return null;
}

/**
 * Validate and hash password before saving
 */
userSchema.pre<IUser>('save', async function () {
  if (!this.isModified('password') || !this.password) return;

  const strengthError = validatePasswordStrength(this.password);
  if (strengthError) {
    throw new Error(strengthError);
  }

  const salt = await bcrypt.genSalt(config.auth.jwt.saltRounds);
  this.password = await bcrypt.hash(this.password, salt);
});

/**
 * Compare password with hash
 */
userSchema.methods.comparePassword = async function (password: string): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(password, this.password);
};

/**
 * Invalidate all user sessions by incrementing token version
 */
userSchema.methods.invalidateAllSessions = async function (): Promise<IUser> {
  this.tokenVersion += 1;
  return this.save();
};

/**
 * Check if user has a specific OAuth provider linked
 */
userSchema.methods.hasOAuthProvider = function (provider: keyof OAuthProviders): boolean {
  return !!this.oauth?.[provider]?.id;
};

/**
 * Get list of linked OAuth providers
 */
userSchema.methods.getLinkedProviders = function (): string[] {
  const providers: string[] = [];
  if (this.oauth?.google?.id) providers.push('google');
  return providers;
};

/**
 * Indexes
 */
userSchema.index({ 'oauth.google.id': 1 }, { sparse: true });
userSchema.index({ organizationId: 1, role: 1 }); // listAllUsers filter: org + role
userSchema.index({ email: 1, username: 1 }); // login lookup: email OR username

export default mongoose.model<IUser>('User', userSchema);
