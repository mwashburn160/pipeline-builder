// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The Express.Request.user augmentation lives in @pipeline-builder/api-core
// (packages/api-core/src/types/common.ts), so there is one shared shape; the
// platform-only fields
// (`isEmailVerified`, `tokenVersion`, `jti`) are tacked on via
// `AccessTokenPayload = JwtPayload & {...}` in `./jwt.ts`. Code that needs
// the extended fields should cast the request user to `AccessTokenPayload`
// at the call site (single-line, type-checked) instead of broadening the
// global declaration here.

export {};
