import type { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { ComputeType } from 'aws-cdk-lib/aws-codebuild';
import type { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Algorithm } from 'jsonwebtoken';

/**
 * Type-safe configuration interface
 */
export interface AppConfig {
  readonly server: ServerConfig;
  readonly auth: AuthConfig;
  readonly database: DatabaseConfig;
  readonly registry: RegistryConfig;
  readonly aws: AWSConfig;
  readonly rateLimit: RateLimitConfig;
}

export interface ServerConfig {
  readonly port: number;
  readonly cors: {
    readonly credentials: boolean;
    readonly origin: string | string[];
  };
  readonly trustProxy: number;
  readonly platformUrl: string;
}

export interface AuthConfig {
  readonly jwt: {
    readonly secret: string;
    readonly expiresIn: number;
    readonly algorithm: Algorithm;
    readonly saltRounds: number;
  };
  readonly refreshToken: {
    readonly secret: string;
    readonly expiresIn: number;
  };
}

export interface DatabaseConfig {
  readonly postgres: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
  };
  readonly mongodb: {
    readonly uri: string;
  };
  readonly drizzle: {
    readonly maxPoolSize: number;
    readonly idleTimeoutMillis: number;
    readonly connectionTimeoutMillis: number;
  };
}

export interface RegistryConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly token: string;
  /** Docker network for build/push (empty string = default). */
  readonly network: string;
}

export interface AWSConfig {
  readonly lambda: {
    readonly runtime: Runtime;
    readonly timeout: Duration;
    readonly memorySize: number;
    readonly architecture: Architecture;
  };
  readonly logging: {
    readonly groupName: string;
    readonly retention: RetentionDays;
    readonly removalPolicy: RemovalPolicy;
  };
  readonly codeBuild: {
    readonly computeType: ComputeType;
  };
}

export interface RateLimitConfig {
  readonly max: number;
  readonly windowMs: number;
  readonly legacyHeaders: boolean;
  readonly standardHeaders: boolean;
}
