// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Express.Request.user augmentation has moved to @pipeline-builder/api-core
// (see packages/api-core/src/types/common.ts). The local `declare global`
// block here previously re-declared `user?: AccessTokenPayload` which
// duplicated the shared shape; the local platform-only fields
// (`isEmailVerified`, `tokenVersion`, `jti`) are tacked on via
// `AccessTokenPayload = JwtPayload & {...}` in `./jwt.ts`. Code that needs
// the extended fields should cast the request user to `AccessTokenPayload`
// at the call site (single-line, type-checked) instead of broadening the
// global declaration here.

export {};
