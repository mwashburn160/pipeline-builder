// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createServiceClient } from '@pipeline-builder/pipeline-core';

// Platform owns the EmailService + user directory; compliance POSTs
// /internal/notify-email to it (see platform/src/routes/notify-email.ts).
export const emailClient = createServiceClient('platform');
