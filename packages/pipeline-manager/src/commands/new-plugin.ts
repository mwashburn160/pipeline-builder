// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import path from 'path';
import {
  PLUGIN_BASE_IMAGES, PLUGIN_CATEGORIES, PLUGIN_COMPUTE_TYPES, PLUGIN_NAME_PATTERN, PLUGIN_SUMMARY_MAX, PLUGIN_TYPES,
  isAllowedSpdxId, validateCatalogField, type PluginBaseImage,
} from '@pipeline-builder/api-core';
import { Command } from 'commander';
import { CURATED_ICON_KEYS } from '../config/plugin-catalog-assets.js';
import { printCommandHeader } from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { printInfo, printSection, printSuccess, printWarning, fileExists, ensureOutputDirectory } from '../utils/output-utils.js';

export interface NewPluginOptions {
  name?: string;
  category?: string;
  base?: string;
  summary?: string;
  description?: string;
  license?: string;
  icon?: string;
  author?: string;
  type?: string;
  compute?: string;
  dir?: string;
  force?: boolean;
  listBases?: boolean;
}

/** A validated scaffold request. */
export interface ScaffoldInput {
  name: string;
  category: string;
  base: PluginBaseImage;
  summary: string;
  description: string;
  license: string;
  icon: string | null;
  author: string;
  pluginType: string;
  computeType: string;
  year: number;
}

/** `my-linter` → `My Linter`. */
export const displayNameOf = (name: string): string =>
  name.split('-').filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ');

/** YAML double-quoted scalar (JSON strings are valid YAML). */
const q = (s: string): string => JSON.stringify(s);

/** Validate the flags into a scaffold request (throws ValidationError). */
export function resolveScaffoldInput(options: NewPluginOptions, now = new Date()): ScaffoldInput {
  const name = options.name ?? '';
  if (!name || !PLUGIN_NAME_PATTERN.test(name) || name.length > 64) {
    throw new ValidationError('--name must be 1-64 lowercase letters, digits and hyphens', 'name', name);
  }
  const category = options.category ?? '';
  if (!(PLUGIN_CATEGORIES as readonly string[]).includes(category)) {
    throw new ValidationError(`--category must be one of: ${PLUGIN_CATEGORIES.join(', ')}`, 'category', category);
  }
  const base = PLUGIN_BASE_IMAGES.find(b => b.key === (options.base ?? 'plugin'));
  if (!base) throw new ValidationError(`--base must be one of: ${PLUGIN_BASE_IMAGES.map(b => b.key).join(', ')} (see --list-bases)`, 'base', options.base);
  const pluginType = options.type ?? 'CodeBuildStep';
  if (!(PLUGIN_TYPES as readonly string[]).includes(pluginType)) throw new ValidationError(`--type must be one of: ${PLUGIN_TYPES.join(', ')}`, 'type', pluginType);
  const computeType = options.compute ?? 'SMALL';
  if (!(PLUGIN_COMPUTE_TYPES as readonly string[]).includes(computeType)) throw new ValidationError(`--compute must be one of: ${PLUGIN_COMPUTE_TYPES.join(', ')}`, 'compute', computeType);
  const license = options.license ?? 'Apache-2.0';
  if (!isAllowedSpdxId(license)) throw new ValidationError('--license must be a supported SPDX identifier (e.g. Apache-2.0, MIT)', 'license', license);
  const icon = options.icon && options.icon !== 'none' ? options.icon : null;
  if (icon !== null && !CURATED_ICON_KEYS.includes(icon)) {
    throw new ValidationError(`--icon must be a curated key (${CURATED_ICON_KEYS.join(', ')}) or none`, 'icon', icon);
  }

  const display = displayNameOf(name);
  const summary = options.summary ?? `${display} as a pipeline step.`;
  const description = options.description
    ?? `${display} runs as a CodeBuild step in your pipeline. Replace this with what the plugin checks or builds, what it reads from the workspace and what it writes.`;
  for (const [field, value] of [['summary', summary], ['description', description]] as const) {
    const checked = validateCatalogField(field, value);
    if (!checked.ok) throw new ValidationError(`--${field} ${checked.error}${field === 'summary' ? ` (max ${PLUGIN_SUMMARY_MAX})` : ''}`, field, value);
  }
  return {
    name,
    category,
    base,
    summary,
    description,
    license,
    icon,
    pluginType,
    computeType,
    author: options.author ?? `The ${name} authors`,
    year: now.getUTCFullYear(),
  };
}

const MIT_TEXT = (year: number, author: string): string => `MIT License

Copyright (c) ${year} ${author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** LICENSE: the MIT text in full, else the SPDX notice (Apache-2.0's own recommended form). */
export function licenseText(input: Pick<ScaffoldInput, 'license' | 'year' | 'author'>): string {
  if (input.license === 'MIT') return MIT_TEXT(input.year, input.author);
  if (input.license === 'Apache-2.0') {
    return `Copyright ${input.year} ${input.author}

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

SPDX-License-Identifier: Apache-2.0
`;
  }
  return `Copyright ${input.year} ${input.author}

This plugin is licensed under ${input.license}.
Full text: https://spdx.org/licenses/${input.license}.html

SPDX-License-Identifier: ${input.license}
`;
}

/** Keywords: the category plus the name's words (≤ 10, each ≤ 32, no duplicates). */
export function scaffoldKeywords(name: string, category: string): string[] {
  return [...new Set([category, ...name.split('-')].filter(w => w.length >= 2 && w.length <= 32))].slice(0, 10);
}

function dockerfileText(input: ScaffoldInput): string {
  const display = displayNameOf(input.name);
  return `# ${display} — ${input.summary}
#
# Thin layer over ${input.base.image} (deploy/plugins/_base/${input.base.dir}:
# ${input.base.provides}). Add ONLY this plugin's own tool, pinned. Rules
# (deploy/plugins/README.md, enforced by test-plugins.sh and \`plugin validate\`):
#   - every download goes through fetch-verified with a pinned version and a
#     pinned per-architecture digest; never a rolling URL, never curl | sh;
#   - switch to root only for the steps that need it, and end as USER 1000:1000;
#   - a tool that ships several versions puts them under /opt/<tool>/versions
#     with the active one symlinked from a uid-1000-owned /opt/<tool>/bin.

FROM ${input.base.image}

# ─── Tool install (uncomment and fill in) ───
# Take each digest from the vendor's published checksum file.
# USER root
# ARG TOOL_VERSION=1.2.3
# ARG TOOL_SHA256_AMD64=<sha256 of the linux-amd64 asset>
# ARG TOOL_SHA256_ARM64=<sha256 of the linux-arm64 asset>
# RUN set -eux; \\
#     case "$(dpkg --print-architecture)" in \\
#       amd64) arch=amd64; sum="\${TOOL_SHA256_AMD64}" ;; \\
#       arm64) arch=arm64; sum="\${TOOL_SHA256_ARM64}" ;; \\
#       *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \\
#     esac; \\
#     fetch-verified "https://example.com/tool/v\${TOOL_VERSION}/tool-linux-\${arch}.tar.gz" "$sum" /tmp/tool.tar.gz; \\
#     install -d /opt/tool/bin; \\
#     tar -xzf /tmp/tool.tar.gz -C /opt/tool/bin; \\
#     rm -f /tmp/tool.tar.gz; \\
#     chmod -R a+rX /opt/tool
# ENV PATH="/opt/tool/bin:\${PATH}"

WORKDIR /app
USER 1000:1000
CMD ["bash"]
`;
}

function specText(input: ScaffoldInput): string {
  const out = `${input.name}-reports`;
  const isApproval = input.pluginType === 'ManualApprovalStep';
  const lines = [
    `name: ${input.name}`,
    `summary: ${q(input.summary)}`,
    `description: ${q(input.description)}`,
    'keywords:',
    ...scaffoldKeywords(input.name, input.category).map(k => `  - ${k}`),
    `category: ${input.category}`,
    'version: 0.1.0',
    `pluginType: ${input.pluginType}`,
    `computeType: ${input.computeType}`,
    `timeout: ${isApproval ? 0 : 10}`,
    'failureBehavior: fail',
    'secrets: []',
  ];
  if (!isApproval) {
    lines.push(
      `primaryOutputDirectory: ${out}`,
      'dockerfile: Dockerfile',
      'installCommands:',
      `  - mkdir -p ${out}`,
      'commands:',
      '  # Replace with the real tool invocation. run-logged (from the base image)',
      '  # streams output to the console AND the log, and exits with the command\'s',
      '  # own status, so a failure is never masked.',
      '  - |',
      '    set -e',
      `    echo "Running ${input.name} in $(pwd)"`,
      `    run-logged ${out}/${input.name}.log -- echo "${input.name} ran"`,
      '# Run against the built image by test-plugins.sh --build and `plugin test`.',
      `smokeTest: ${q(input.base.smokeTest)}`,
    );
  }
  lines.push(
    '',
    '# ─── Catalog metadata (plugin-ecosystem §3.1a) ───',
    `license: ${input.license}`,
    input.icon
      ? `icon: ${input.icon}  # curated keys are for Official and Verified listings; Community listings upload an icon`
      : '# icon: none — a Community listing uploads a raster icon or shows its monogram',
    'changelog: |',
    '  0.1.0: Initial release.',
    '',
  );
  return lines.join('\n');
}

function readmeText(input: ScaffoldInput, relDir: string): string {
  const display = displayNameOf(input.name);
  return `# ${display}

${input.description}

## Use it in a pipeline

\`\`\`yaml
steps:
  - plugin: { name: ${input.name} }
\`\`\`

${input.pluginType === 'ManualApprovalStep' ? '' : `The step writes its results to \`${input.name}-reports/\` (its primary output).

`}## Develop

\`\`\`bash
pipeline-manager plugin validate --dir ${relDir}   # the server's schema + catalog report
pipeline-manager plugin test --dir ${relDir} --workspace ./sample-app
pipeline-manager plugin publish --dir ${relDir}    # pre-flight, accept or edit metadata, submit
\`\`\`

The image builds FROM \`${input.base.image}\`; build the bases first with
\`deploy/bin/build-plugin-images.sh\`, or pass \`--image\` to \`plugin test\`.

## License

${input.license} — see [LICENSE](LICENSE).
`;
}

/** Every file of a new plugin, keyed by path relative to the plugin directory. */
export function scaffoldFiles(input: ScaffoldInput, relDir = `./${input.name}`): Record<string, string> {
  const isApproval = input.pluginType === 'ManualApprovalStep';
  const files: Record<string, string> = {
    'config.yaml': isApproval
      ? 'pluginSpec: plugin-spec.yaml\nbuildType: metadata_only\n'
      : 'pluginSpec: plugin-spec.yaml\nbuildType: build_image\ndockerfile: Dockerfile\n',
    'plugin-spec.yaml': specText(input),
    'README.md': readmeText(input, relDir),
    'LICENSE': licenseText(input),
  };
  if (!isApproval) files.Dockerfile = dockerfileText(input);
  return files;
}

/** Print the available plugin bases. */
export function printBases(): void {
  printSection('Plugin base images', 'deploy/plugins/_base');
  for (const b of PLUGIN_BASE_IMAGES) console.log(`  ${b.key.padEnd(8)} ${b.image.padEnd(28)} ${b.provides}`);
}

/**
 * Register `plugin new` — scaffold a plugin FROM a `pipeline-<eco>-base` image:
 * a Dockerfile that follows the catalog rules, a spec with catalog metadata, a
 * README, a changelog entry and a LICENSE. It passes `plugin validate` and
 * test-plugins.sh's static checks as generated.
 *
 * Usage:
 *   pipeline-manager plugin new --list-bases
 *   pipeline-manager plugin new --name my-linter --category quality --base node
 */
export function newPlugin(program: Command): void {
  program
    .command('new')
    .description('Scaffold a plugin from a pipeline-<eco>-base image (Dockerfile, spec, README, LICENSE)')
    .option('--name <name>', 'Plugin name (lowercase letters, digits, hyphens)')
    .option('--category <category>', `Category: ${PLUGIN_CATEGORIES.join(' | ')}`)
    .option('--base <eco>', `Base image: ${PLUGIN_BASE_IMAGES.map(b => b.key).join(' | ')}`, 'plugin')
    .option('--summary <text>', `Catalog one-liner (≤ ${PLUGIN_SUMMARY_MAX})`)
    .option('--description <text>', 'Catalog description')
    .option('--license <spdx>', 'SPDX license id', 'Apache-2.0')
    .option('--icon <key>', 'Curated icon key (Official/Verified listings only), or none', 'none')
    .option('--author <name>', 'Copyright holder for LICENSE')
    .option('--type <type>', `Plugin type: ${PLUGIN_TYPES.join(' | ')}`, 'CodeBuildStep')
    .option('--compute <compute>', `Compute type: ${PLUGIN_COMPUTE_TYPES.join(' | ')}`, 'SMALL')
    .option('--dir <path>', 'Target directory (default ./<name>)')
    .option('--force', 'Overwrite an existing directory', false)
    .option('--list-bases', 'List the available base images and exit', false)
    .action((options: NewPluginOptions) => {
      if (options.listBases) {
        printBases();
        return;
      }
      const executionId = printCommandHeader('New Plugin');
      try {
        const input = resolveScaffoldInput(options);
        const relDir = options.dir ?? `./${input.name}`;
        const targetDir = path.resolve(relDir);
        if (fileExists(targetDir) && !options.force) {
          throw new ValidationError(`Directory already exists: ${targetDir} (use --force to overwrite)`);
        }
        ensureOutputDirectory(targetDir);
        const files = scaffoldFiles(input, relDir);
        for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(targetDir, file), content, 'utf-8');

        if (input.icon) printWarning('Curated icons are reserved for Official listings and Verified publishers who own the mark; a Community listing with one is refused at submit');
        printSection('Scaffolded plugin', targetDir);
        printInfo('Created files', { files: Object.keys(files), base: input.base.image });
        printSuccess('Plugin scaffold created — next: plugin validate, plugin test, plugin publish', { executionId, dir: targetDir });
      } catch (err) {
        handleError(err, err instanceof ValidationError ? ERROR_CODES.VALIDATION : ERROR_CODES.GENERAL, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'plugin new', executionId },
        });
      }
    });
}
