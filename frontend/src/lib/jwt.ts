import { base64UrlDecode } from './api';

export interface JwtPayload {
  [key: string]: unknown;
}

export interface JwtParts {
  header: Record<string, unknown>;
  payload: JwtPayload;
  signature: string;
}

export function decodeJwt(token: string): JwtParts | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(base64UrlDecode(parts[0]));
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return { header, payload, signature: parts[2] };
  } catch {
    return null;
  }
}

export function formatTimestamp(value: unknown): string | null {
  if (typeof value !== 'number') return null;
  const ms = value < 1e12 ? value * 1000 : value;
  return new Date(ms).toLocaleString();
}

export function isExpired(payload: JwtPayload): boolean {
  if (typeof payload.exp !== 'number') return false;
  return Date.now() > payload.exp * 1000;
}

export function expiresIn(payload: JwtPayload): string | null {
  if (typeof payload.exp !== 'number') return null;
  const diff = payload.exp * 1000 - Date.now();
  if (diff <= 0) return 'Expired';
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}
