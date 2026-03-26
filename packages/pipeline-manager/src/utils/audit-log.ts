import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Local audit logger for sensitive CLI operations.
 * Writes timestamped entries to ~/.pipeline-manager/audit.log.
 * Never logs credentials or tokens — only operation metadata.
 */

const AUDIT_DIR = path.join(os.homedir(), '.pipeline-manager');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');
const MAX_AUDIT_SIZE = 1024 * 1024; // 1MB — rotate when exceeded

interface AuditEntry {
  timestamp: string;
  command: string;
  user?: string;
  details?: Record<string, unknown>;
}

/**
 * Log a sensitive operation to the local audit file.
 *
 * @param command - The command name (e.g., 'store-token', 'deploy', 'bootstrap')
 * @param details - Non-sensitive metadata about the operation
 */
export function auditLog(command: string, details?: Record<string, unknown>): void {
  try {
    if (!fs.existsSync(AUDIT_DIR)) {
      fs.mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
    }

    // Rotate if file is too large
    if (fs.existsSync(AUDIT_FILE)) {
      const stats = fs.statSync(AUDIT_FILE);
      if (stats.size > MAX_AUDIT_SIZE) {
        const rotated = `${AUDIT_FILE}.1`;
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(AUDIT_FILE, rotated);
      }
    }

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      command,
      user: os.userInfo().username,
      details,
    };

    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    // Audit logging is best-effort — never block the CLI
  }
}
