import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import path from 'path';

import { createLogger, ValidationError } from '@mwashburn160/api-core';
import { Config } from '@mwashburn160/pipeline-core';

const logger = createLogger('docker-build');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type BuildStrategy = 'docker' | 'kaniko' | 'podman';

/** Local mirror of pipeline-core's DockerBuildCfg (cast needed for pnpm workspace compatibility). */
interface DockerBuildCfg {
  strategy: BuildStrategy;
  tempRoot: string;
  timeoutMs: number;
  pushTimeoutMs: number;
  kanikoExecutor: string;
  kanikoCacheDir: string;
}

export interface RegistryInfo {
  host: string;
  port: number;
  user: string;
  token: string;
  network: string;
  http: boolean;
  insecure: boolean;
}

export interface BuildRequest {
  contextDir: string;
  dockerfile: string;
  imageTag: string;
  registry: RegistryInfo;
  buildArgs?: Record<string, string>;
}

export interface BuildResult {
  fullImage: string;
}

// -----------------------------------------------------------------------------
// Strategy definitions
// -----------------------------------------------------------------------------

interface StrategyDef {
  binary: string;
  setupAuth: (contextDir: string, registry: RegistryInfo) => void;
  tlsArgs: (registry: RegistryInfo) => string[];
  buildArgs: (contextDir: string, dockerfile: string, image: string, registry: RegistryInfo, buildArgs?: Record<string, string>) => string[];
  pushArgs: (image: string, registry: RegistryInfo) => string[];
  cleanup: (binary: string, image: string) => void;
  patchConfnew: boolean;
}

/** Auth file path set by setupAuth, reused by pushArgs for podman. */
let authFilePath = '';

const strategies: Record<Exclude<BuildStrategy, 'kaniko'>, StrategyDef> = {
  docker: {
    binary: 'docker',
    setupAuth(contextDir: string, registry: RegistryInfo) {
      const dir = path.join(contextDir, '.docker');
      fs.mkdirSync(dir, { recursive: true });
      writeAuthJson(dir, registry);
      process.env.DOCKER_CONFIG = dir;
      authFilePath = '';
    },
    tlsArgs: () => [],
    buildArgs(contextDir: string, dockerfile: string, image: string, registry: RegistryInfo, args?: Record<string, string>) {
      return [
        'build', '--progress', 'plain',
        ...(registry.network ? [`--network=${registry.network}`] : []),
        ...flagBuildArgs(args),
        '-f', path.join(contextDir, dockerfile), '-t', image, contextDir,
      ];
    },
    pushArgs: (image: string) => ['push', image],
    cleanup(binary: string, image: string) {
      try { execFileSync(binary, ['rmi', image], { stdio: 'ignore' }); } catch { /* best-effort */ }
    },
    patchConfnew: true,
  },
  podman: {
    binary: 'podman',
    setupAuth(contextDir: string, registry: RegistryInfo) {
      const dir = path.join(contextDir, '.docker');
      fs.mkdirSync(dir, { recursive: true });
      writeAuthJson(dir, registry);
      authFilePath = path.join(dir, 'config.json');
    },
    tlsArgs(registry: RegistryInfo) {
      return (registry.insecure || registry.http) ? ['--tls-verify=false'] : [];
    },
    buildArgs(contextDir: string, dockerfile: string, image: string, registry: RegistryInfo, args?: Record<string, string>) {
      return [
        'build', '--progress', 'plain', '--layers',
        ...this.tlsArgs(registry),
        ...(authFilePath ? [`--authfile=${authFilePath}`] : []),
        ...flagBuildArgs(args),
        '-f', path.join(contextDir, dockerfile), '-t', image, contextDir,
      ];
    },
    pushArgs(image: string, registry: RegistryInfo) {
      return ['push', ...this.tlsArgs(registry), ...(authFilePath ? [`--authfile=${authFilePath}`] : []), image];
    },
    cleanup(binary: string, image: string) {
      try { execFileSync(binary, ['rmi', image], { stdio: 'ignore' }); } catch { /* best-effort */ }
    },
    patchConfnew: false,
  },
};

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

function getConfig(): DockerBuildCfg {
  return Config.getAny('dockerConfig') as DockerBuildCfg;
}

export const BUILD_TEMP_ROOT = getConfig().tempRoot;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Build a container image and push it to the registry.
 *
 * Strategy (DOCKER_BUILD_STRATEGY): docker, podman, kaniko.
 */
export async function buildAndPush(req: BuildRequest): Promise<BuildResult> {
  validate(req);

  const config = getConfig();
  const image = `${req.registry.host}:${req.registry.port}/plugin:${req.imageTag}`;

  logger.info('Building image', { strategy: config.strategy, image });

  if (config.strategy === 'kaniko') {
    await runKaniko(config, req, image);
  } else {
    await runOCI(config, req, image);
  }

  return { fullImage: image };
}

// -----------------------------------------------------------------------------
// OCI (docker / podman) — driven by strategy record
// -----------------------------------------------------------------------------

async function runOCI(cfg: DockerBuildCfg, req: BuildRequest, image: string) {
  const { contextDir, dockerfile, registry, buildArgs } = req;
  const s = strategies[cfg.strategy as keyof typeof strategies];

  s.setupAuth(contextDir, registry);
  patchDockerfile(contextDir, dockerfile, s.patchConfnew);

  await run(s.binary, s.buildArgs(contextDir, dockerfile, image, registry, buildArgs), cfg.timeoutMs);

  try {
    await run(s.binary, s.pushArgs(image, registry), cfg.pushTimeoutMs);
  } finally {
    s.cleanup(s.binary, image);
  }
}

// -----------------------------------------------------------------------------
// Kaniko — separate path (single command, no push step)
// -----------------------------------------------------------------------------

async function runKaniko(cfg: DockerBuildCfg, req: BuildRequest, image: string) {
  const { contextDir, dockerfile, registry, buildArgs } = req;

  const dockerDir = process.env.DOCKER_CONFIG || '/kaniko/.docker';
  fs.mkdirSync(dockerDir, { recursive: true });
  process.env.DOCKER_CONFIG = dockerDir;
  writeAuthJson(dockerDir, registry);

  patchDockerfile(contextDir, dockerfile, true);

  await run(cfg.kanikoExecutor, [
    `--context=${contextDir}`,
    `--dockerfile=${path.join(contextDir, dockerfile)}`,
    `--destination=${image}`,
    '--verbosity=info', '--log-format=json',
    '--cache=true', `--cache-dir=${cfg.kanikoCacheDir}`,
    '--cleanup', '--reproducible', '--snapshot-mode=redo',
    '--push-retry=2', '--image-fs-extract-retry=2', '--image-download-retry=3',
    ...(registry.http ? ['--insecure', '--insecure-pull'] : []),
    ...(registry.insecure ? ['--skip-tls-verify', '--skip-tls-verify-pull'] : []),
    ...flagBuildArgs(buildArgs, true),
  ], cfg.timeoutMs);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function writeAuthJson(dir: string, registry: RegistryInfo) {
  const addr = `${registry.host}:${registry.port}`;
  const auth = Buffer.from(`${registry.user}:${registry.token}`).toString('base64');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auths: { [addr]: { auth } } }));
}

function patchDockerfile(contextDir: string, dockerfile: string, forceConfnew: boolean) {
  const file = path.join(contextDir, dockerfile);
  const src = fs.readFileSync(file, 'utf-8');
  const inject = forceConfnew
    ? 'ENV DEBIAN_FRONTEND=noninteractive\nRUN echo "force-confnew" > /etc/dpkg/dpkg.cfg.d/kaniko-force-confnew 2>/dev/null || true'
    : 'ENV DEBIAN_FRONTEND=noninteractive';
  fs.writeFileSync(file, src.replace(/^(FROM\s+[^\n]+)/gm, `$1\n${inject}`));
}

function flagBuildArgs(args?: Record<string, string>, joined = false): string[] {
  if (!args) return [];
  return Object.entries(args).flatMap(([k, v]) =>
    joined ? [`--build-arg=${k}=${v}`] : ['--build-arg', `${k}=${v}`],
  );
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

const RE_HOST = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const RE_TAG = /^[a-z0-9][a-z0-9._-]*$/;
const RE_NET = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const RE_ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validate({ registry, imageTag, buildArgs }: BuildRequest) {
  if (!RE_HOST.test(registry.host)) throw new ValidationError(`Invalid registry host: ${registry.host}`);
  if (!Number.isInteger(registry.port) || registry.port < 1 || registry.port > 65535) throw new ValidationError(`Invalid registry port: ${registry.port}`);
  if (!RE_TAG.test(imageTag)) throw new ValidationError(`Invalid image tag: ${imageTag}`);
  if (registry.network && !RE_NET.test(registry.network)) throw new ValidationError(`Invalid network: ${registry.network}`);
  for (const [k, v] of Object.entries(buildArgs || {})) {
    if (!RE_ARG_KEY.test(k)) throw new ValidationError(`Invalid build arg key: ${k}`);
    if (typeof v !== 'string' || v.length > 4096) throw new ValidationError(`Invalid build arg value for ${k}`);
  }
}

// -----------------------------------------------------------------------------
// Secret masking
// -----------------------------------------------------------------------------

const SECRET_RE = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIALS|AUTH)([=: ]+)([^\s"']+)/gi;

function maskSecrets(line: string): string {
  return line.replace(SECRET_RE, '$1$2***');
}

// -----------------------------------------------------------------------------
// Process runner
// -----------------------------------------------------------------------------

function run(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Set Docker dind TLS env vars per-process when certs are available
    const env = { ...process.env };
    if (binary === 'docker' && !env.DOCKER_HOST) {
      const certPath = env.DOCKER_CERT_PATH || '/app/dind-certs/client';
      if (fs.existsSync(path.join(certPath, 'ca.pem'))) {
        const dindHost = env.DIND_HOST || 'localhost';
        env.DOCKER_HOST = `tcp://${dindHost}:2376`;
        env.DOCKER_TLS_VERIFY = '1';
        env.DOCKER_CERT_PATH = certPath;
      }
    }
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    const pipe = (stream: string) => (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) logger.info(maskSecrets(line), { stream });
    };
    child.stdout.on('data', pipe('stdout'));
    child.stderr.on('data', pipe('stderr'));

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Build timed out after ${timeoutMs}ms`));
      else if (code !== 0) reject(new Error(`Build failed with exit code ${code}`));
      else resolve();
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}
