import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Algorithm } from 'jsonwebtoken';
import type { ComputeType } from '../core/pipeline-types';

/**
 * Type-safe configuration interface
 */
export interface AppConfig {
  server: ServerConfig;
  auth: AuthConfig;
  database: DatabaseConfig;
  registry: RegistryConfig;
  aws: AWSConfig;
  rateLimit: RateLimitConfig;
}

export interface ServerConfig {
  port: string;
  cors: {
    credentials: boolean;
    origin: string | string[];
  };
  trustProxy: string;
  platformUrl: string;
}

export interface AuthConfig {
  jwt: {
    secret: string;
    expiresIn: string;
    algorithm: Algorithm;
    saltRounds: string;
  };
  refreshToken: {
    secret: string;
    expiresIn: string;
  };
}

export interface DatabaseConfig {
  postgres: {
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
  };
  mongodb: {
    uri: string;
  };
  drizzle: {
    maxPoolSize: string;
    idleTimeoutMillis: string;
    connectionTimeoutMillis: string;
  };
}

export interface RegistryConfig {
  host: string;
  port: string;
  user: string;
  token: string;
  /** Docker network for build/push (empty string = default). */
  network: string;
}

export interface AWSConfig {
  lambda: {
    runtime: Runtime;
    timeout: Duration;
    memorySize: number;
    architecture: Architecture;
  };
  logging: {
    groupName: string;
    retention: RetentionDays;
    removalPolicy: RemovalPolicy;
  };
  codeBuild: {
    computeType: ComputeType;
  };
}

export interface RateLimitConfig {
  max: string;
  windowMs: string;
  legacyHeaders: boolean;
  standardHeaders: boolean;
}
