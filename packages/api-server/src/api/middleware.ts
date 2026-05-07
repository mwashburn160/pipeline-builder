// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Convenience re-export: api-server consumers usually compose middleware
// already imported from this package, so `requireAuth` is exposed here too.
// Other auth middleware (requireAdmin, requireFeature, isSystemOrg/Admin)
// is consumed directly from api-core where it's defined.
export { requireAuth } from '@pipeline-builder/api-core';
