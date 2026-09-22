# shell

Basic shell step on a clean Ubuntu 24.04 environment (git/curl/jq/wget/tar/zip/apt). Takes no metadata — the pipeline step supplies its own commands. Use when no language/tool-specific plugin fits.

**Version:** 1.0.0  
**Category:** infrastructure  
**Plugin Type:** CodeBuildStep  
**Compute:** SMALL  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`shell`, `bash`, `custom`, `generic`, `script`

## What it does

The plugin only prepares the environment: it creates `shell-output/` (the step's primary output directory). Every command comes from the pipeline step's own `commands`, so it runs whatever script you give it with the tools of the base image: `bash`, `git`, `curl`, `jq`, `wget`, `tar`, `zip` and `apt-retry-install` for extra packages.

It runs as the non-root `plugin` user (uid 1000).

## Secrets

None.

## Usage

```yaml
steps:
  - name: package
    plugin: { name: shell }
    commands:
      - ./scripts/package.sh
      - cp dist/*.zip shell-output/
```

## Output

Anything your commands write to `shell-output/`.
