// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import os from 'os';
import path from 'path';
import { printDebug } from './output-utils.js';

/**
 * Local audit logger for sensitive CLI operations.
 * Writes timestamped entries to ~/.pipeline-manager/audit.log.
 * Never logs credentials or tokens — only operation metadata.
 */

const AUDIT_DIR = path.join(os.homedir(), '.pipeline-manager');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');
const MAX_AUDIT_SIZE = 1024 * 1024; // 1MB — rotate when exceeded
const MAX_ROTATED = 5; // keep audit.log.1 .. .5 (history isn't lost on repeated rotations)

/** Shift audit.log.{n} → .{n+1} (dropping the oldest), then audit.log → .1. */
function rotate(): void {
  const oldest = `${AUDIT_FILE}.${MAX_ROTATED}`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let i = MAX_ROTATED - 1; i >= 1; i--) {
    const src = `${AUDIT_FILE}.${i}`;
    if (fs.existsSync(src)) fs.renameSync(src, `${AUDIT_FILE}.${i + 1}`);
  }
  fs.renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
}

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

    // Rotate if file is too large (keeps MAX_ROTATED archives)
    if (fs.existsSync(AUDIT_FILE) && fs.statSync(AUDIT_FILE).size > MAX_AUDIT_SIZE) {
      rotate();
    }

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      command,
      user: os.userInfo().username,
      details,
    };

    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (err) {
    // Audit logging is best-effort — never block the CLI — but surface the failure
    // in debug so a silently-unrecorded sensitive op is at least diagnosable.
    printDebug('Audit log write failed', { command, error: err instanceof Error ? err.message : String(err) });
  }
}
