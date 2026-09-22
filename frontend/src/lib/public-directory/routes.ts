// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The public plugin directory (`/plugins`, its category and plugin pages) —
 * server-rendered, CDN-cached, read mostly by signed-out visitors and crawlers.
 * `/plugins/submit` is the signed-in submission flow and keeps the full shell.
 */
export function isPublicDirectoryRoute(pathname: string): boolean {
  if (pathname === '/plugins') return true;
  return pathname.startsWith('/plugins/') && !pathname.startsWith('/plugins/submit');
}
