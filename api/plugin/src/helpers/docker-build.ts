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
  binary: (cfg: DockerBuildCfg) => string;
  setupAuth: (contextDir: string, registry: RegistryInfo) => string[];
  buildCli: (cfg: DockerBuildCfg, req: BuildRequest, image: string, authArgs: string[]) => string[];
  pushCli: (image: string, registry: RegistryInfo, authArgs: string[]) => string[] | null;
  cleanup: (binary: string, image: string) => void;
  patchConfnew: boolean;
}

function ociAuthDir(contextDir: string, registry: RegistryInfo): string {
  const dir = path.join(contextDir, '.docker');
  fs.mkdirSync(dir, { recursive: true });
  writeAuthJson(dir, registry);
  return dir;
}

function ociCleanup(binary: string, image: string) {
  try { execFileSync(binary, ['rmi', image], { stdio: 'ignore' }); } catch { /* best-effort */ }
}

function podmanTls(registry: RegistryInfo): string[] {
  return (registry.insecure || registry.http) ? ['--tls-verify=false'] : [];
}

const strategies: Record<BuildStrategy, StrategyDef> = {
  docker: {
    binary: () => 'docker',
    setupAuth(contextDir: string, registry: RegistryInfo) {
      const dir = ociAuthDir(contextDir, registry);
      process.env.DOCKER_CONFIG = dir;
      // Detect dind sidecar via DIND_HOST env var (set by docker-compose/K8s)
      const dindHost = process.env.DIND_HOST;
      if (dindHost && !process.env.DOCKER_HOST) {
        process.env.DOCKER_HOST = `tcp://${dindHost}:2375`;
      }
      return [];
    },
    buildCli(_cfg: DockerBuildCfg, req: BuildRequest, image: string) {
      return [
        'build', '--progress', 'plain',
        ...(req.registry.network ? [`--network=${req.registry.network}`] : []),
        ...flagBuildArgs(req.buildArgs),
        '-f', path.join(req.contextDir, req.dockerfile), '-t', image, req.contextDir,
      ];
    },
    pushCli: (image: string) => ['push', image],
    cleanup: ociCleanup,
    patchConfnew: true,
  },

  podman: {
    binary: () => 'podman',
    setupAuth(contextDir: string, registry: RegistryInfo) {
      const dir = ociAuthDir(contextDir, registry);
      return [`--authfile=${path.join(dir, 'config.json')}`];
    },
    buildCli(_cfg: DockerBuildCfg, req: BuildRequest, image: string, authArgs: string[]) {
      return [
        'build', '--progress', 'plain', '--layers',
        ...podmanTls(req.registry), ...authArgs,
        ...flagBuildArgs(req.buildArgs),
        '-f', path.join(req.contextDir, req.dockerfile), '-t', image, req.contextDir,
      ];
    },
    pushCli(image: string, registry: RegistryInfo, authArgs: string[]) {
      return ['push', ...podmanTls(registry), ...authArgs, image];
    },
    cleanup: ociCleanup,
    patchConfnew: false,
  },

  kaniko: {
    binary: (cfg: DockerBuildCfg) => cfg.kanikoExecutor,
    setupAuth(_contextDir: string, registry: RegistryInfo) {
      const dir = process.env.DOCKER_CONFIG || '/kaniko/.docker';
      fs.mkdirSync(dir, { recursive: true });
      process.env.DOCKER_CONFIG = dir;
      writeAuthJson(dir, registry);
      return [];
    },
    buildCli(cfg: DockerBuildCfg, req: BuildRequest, image: string) {
      return [
        `--context=${req.contextDir}`,
        `--dockerfile=${path.join(req.contextDir, req.dockerfile)}`,
        `--destination=${image}`,
        '--verbosity=info', '--log-format=json',
        '--cache=true', `--cache-dir=${cfg.kanikoCacheDir}`,
        '--cleanup', '--reproducible', '--snapshot-mode=redo',
        '--push-retry=2', '--image-fs-extract-retry=2', '--image-download-retry=3',
        ...(req.registry.http ? ['--insecure', '--insecure-pull'] : []),
        ...(req.registry.insecure ? ['--skip-tls-verify', '--skip-tls-verify-pull'] : []),
        ...flagBuildArgs(req.buildArgs, true),
      ];
    },
    pushCli: () => null,
    cleanup: () => {},
    patchConfnew: true,
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

export async function buildAndPush(req: BuildRequest): Promise<BuildResult> {
  validate(req);

  const cfg = getConfig();
  const image = `${req.registry.host}:${req.registry.port}/plugin:${req.imageTag}`;
  const s = strategies[cfg.strategy];
  const bin = s.binary(cfg);

  logger.info('Building image', { strategy: cfg.strategy, image });

  const authArgs = s.setupAuth(req.contextDir, req.registry);
  patchDockerfile(req.contextDir, req.dockerfile, s.patchConfnew);

  await run(bin, s.buildCli(cfg, req, image, authArgs), cfg.timeoutMs);

  const push = s.pushCli(image, req.registry, authArgs);
  if (push) {
    try {
      await run(bin, push, cfg.pushTimeoutMs);
    } finally {
      s.cleanup(bin, image);
    }
  }

  return { fullImage: image };
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
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
