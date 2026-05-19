// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Jest setup file (runs after the test framework is installed in the env).
 * Registers @testing-library/jest-dom matchers like toBeInTheDocument,
 * toHaveTextContent, etc. so all .test.tsx files can use them without
 * a per-file import.
 */

import '@testing-library/jest-dom';
