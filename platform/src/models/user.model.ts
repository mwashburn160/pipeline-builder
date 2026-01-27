import bcrypt from 'bcryptjs';
import mongoose, { Schema, Document, Types } from 'mongoose';
import { config } from '../index';

export interface IUser extends Document {
  _id: Types.ObjectId;
  username: string;
  email: string;
  password?: string;
  role: 'user' | 'admin';
  organizationId?: Types.ObjectId;
  isEmailVerified: boolean;
  tokenVersion: number;
  refreshToken?: string;
  comparePassword(password: string): Promise<boolean>;
  invalidateAllSessions(): Promise<IUser>;
}

const userSchema = new Schema<IUser>({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, select: false },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },
  isEmailVerified: { type: Boolean, default: false },
  tokenVersion: { type: Number, default: 0 },
  refreshToken: { type: String, select: false },
}, { timestamps: true });

userSchema.pre<IUser>('save', async function () {
  if (!this.isModified('password') || !this.password) return;
  const salt = await bcrypt.genSalt(config.auth.jwt.saltRounds);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function (password: string): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(password, this.password);
};

userSchema.methods.invalidateAllSessions = async function () {
  this.tokenVersion += 1;
  return this.save();
};

export default mongoose.model<IUser>('User', userSchema);