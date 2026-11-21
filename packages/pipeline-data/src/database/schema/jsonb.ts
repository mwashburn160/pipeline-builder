// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

//
// The schema's `jsonb` column: drizzle's, minus the second parse.
//
// Both drivers this package uses (node-postgres, PGlite) already parse json /
// jsonb into JS values. drizzle's stock `PgJsonb.mapFromDriverValue` then
// JSON.parses any STRING it is handed again — so a jsonb holding a string that
// looks like a JSON literal ("true", "1", "null", "[]") read back as a boolean,
// number, null or array (e.g. `plugins.smoke_test: "true"` became `true`, and
// the plugin had "no smoke test"). This column returns the driver's value as
// is; writes are unchanged (JSON.stringify). Every schema file imports `jsonb`
// from here, never from 'drizzle-orm/pg-core' (pinned by
// test/jsonb-scalar-roundtrip.test.ts).
//

import { PgJsonb, PgJsonbBuilder, type PgJsonbBuilderInitial } from 'drizzle-orm/pg-core';

/* eslint-disable @typescript-eslint/no-explicit-any */
class DriverParsedJsonb extends PgJsonb<any> {
  override mapFromDriverValue(value: unknown): unknown {
    return value;
  }
}

class DriverParsedJsonbBuilder extends PgJsonbBuilder<any> {
  /** @internal */
  build(table: any): any {
    return new DriverParsedJsonb(table, (this as any).config);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A jsonb column whose read value is exactly what the driver parsed. */
export function jsonb<TName extends string>(name: TName): PgJsonbBuilderInitial<TName> {
  return new DriverParsedJsonbBuilder(name) as unknown as PgJsonbBuilderInitial<TName>;
}
