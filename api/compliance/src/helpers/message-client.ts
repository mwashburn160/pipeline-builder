// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createServiceClient } from '@pipeline-builder/pipeline-core';

// In-app notifications go to the message service's inbox.
export const messageClient = createServiceClient('message');
