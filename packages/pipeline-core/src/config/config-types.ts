import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { ComputeType } from 'aws-cdk-lib/aws-codebuild';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Algorithm } from 'jsonwebtoken';

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
  port: number;
  cors: {
    credentials: boolean;
    origin: string | string[];
  };
  trustProxy: number;
  platformUrl: string;
}

export interface AuthConfig {
  jwt: {
    secret: string;
    expiresIn: number;
    algorithm: Algorithm;
    saltRounds: number;
  };
  refreshToken: {
    secret: string;
    expiresIn: number;
  };
}

export interface DatabaseConfig {
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  mongodb: {
    uri: string;
  };
  drizzle: {
    maxPoolSize: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
  };
}

export interface RegistryConfig {
  host: string;
  port: number;
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
  max: number;
  windowMs: number;
  legacyHeaders: boolean;
  standardHeaders: boolean;
}
