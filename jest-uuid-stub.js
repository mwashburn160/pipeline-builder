// CJS stub for uuid v13 (ESM-only) — used by jest via moduleNameMapper
const crypto = require('crypto');

module.exports = {
  v4: () => crypto.randomUUID(),
  v7: () => crypto.randomUUID(),
  NIL: '00000000-0000-0000-0000-000000000000',
  MAX: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  validate: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  version: (s) => parseInt(s.charAt(14), 16),
};
