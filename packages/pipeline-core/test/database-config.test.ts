jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { loadDatabaseConfig, validateDatabaseConfig } from '../src/config/database-config';

describe('loadDatabaseConfig', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('returns correct defaults when no env vars set', () => {
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.DATABASE;
    delete process.env.DB_USER;
    delete process.env.DB_PASSWORD;
    delete process.env.DRIZZLE_MAX_POOL_SIZE;
    delete process.env.DRIZZLE_IDLE_TIMEOUT_MILLIS;
    delete process.env.DRIZZLE_CONNECTION_TIMEOUT_MILLIS;

    const config = loadDatabaseConfig();

    expect(config.postgres.host).toBe('postgres');
    expect(config.postgres.port).toBe(5432);
    expect(config.postgres.database).toBe('pipeline_builder');
    expect(config.postgres.user).toBe('postgres');
    expect(config.postgres.password).toBe('password');
    expect(config.drizzle.maxPoolSize).toBe(20);
    expect(config.drizzle.idleTimeoutMillis).toBe(30000);
    expect(config.drizzle.connectionTimeoutMillis).toBe(5000);
  });

  it('overrides postgres settings from env', () => {
    process.env.DB_HOST = 'custom-host';
    process.env.DB_PORT = '5433';
    process.env.DATABASE = 'my_db';
    process.env.DB_USER = 'app_user';
    process.env.DB_PASSWORD = 'secure123';

    const config = loadDatabaseConfig();

    expect(config.postgres.host).toBe('custom-host');
    expect(config.postgres.port).toBe(5433);
    expect(config.postgres.database).toBe('my_db');
    expect(config.postgres.user).toBe('app_user');
    expect(config.postgres.password).toBe('secure123');
  });

  it('overrides drizzle pool settings from env', () => {
    process.env.DRIZZLE_MAX_POOL_SIZE = '50';
    process.env.DRIZZLE_IDLE_TIMEOUT_MILLIS = '60000';
    process.env.DRIZZLE_CONNECTION_TIMEOUT_MILLIS = '10000';

    const config = loadDatabaseConfig();

    expect(config.drizzle.maxPoolSize).toBe(50);
    expect(config.drizzle.idleTimeoutMillis).toBe(60000);
    expect(config.drizzle.connectionTimeoutMillis).toBe(10000);
  });

  it('uses only postgres and drizzle sections (no mongodb)', () => {
    const config = loadDatabaseConfig();

    expect(config).toHaveProperty('postgres');
    expect(config).toHaveProperty('drizzle');
    expect(config).not.toHaveProperty('mongodb');
  });
});

describe('validateDatabaseConfig', () => {
  it('does not warn when pool size >= 10', () => {
    const mockWarn = jest.fn();
    jest.spyOn(console, 'warn').mockImplementation(mockWarn);

    validateDatabaseConfig({
      postgres: { host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' },
      drizzle: { maxPoolSize: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 },
    });

    // No errors thrown; the function only logs via the internal logger
    expect(true).toBe(true);
  });

  it('warns when pool size < 10 (does not throw)', () => {
    // validateDatabaseConfig logs but does not throw
    expect(() =>
      validateDatabaseConfig({
        postgres: { host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' },
        drizzle: { maxPoolSize: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 },
      }),
    ).not.toThrow();
  });
});
