// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import { errorMessage } from '@pipeline-builder/api-core';
import { Command } from 'commander';
import ora from 'ora';
import pico from 'picocolors';
import {
  type InstantiateTemplateRequest,
  type InstantiateTemplateResponse,
  type PipelineTemplate,
  type PipelineProps,
} from '../types/index.js';
import { createAuthenticatedClient, printCommandHeader, printExecutionSummary, printSslWarning, withSslOptions } from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { outputData, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import { extractListResponse, extractSingleResponse } from '../utils/response-utils.js';

const { bold, cyan, dim, green } = pico;

/**
 * Accumulate a repeatable `--input KEY=VALUE` flag. This only collects — it does
 * NOT validate, because Commander runs `parseArg` before the action callback, so
 * a throw here would escape the action's `handleError` and surface as an
 * unhandled stack trace with the wrong exit code instead of a clean validation
 * failure. Parsing happens in {@link parseInputPairs}, inside the action.
 */
function collectInput(pair: string, previous: string[]): string[] {
  return [...previous, pair];
}

/**
 * Split collected `KEY=VALUE` pairs into a map. Values stay strings; the platform
 * coerces each to its declared input type (and rejects what doesn't fit), so the
 * CLI does not guess types locally. Only the FIRST `=` splits, so a value may
 * itself contain `=`.
 */
function parseInputPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) {
      throw new ValidationError(
        `Invalid --input "${pair}" — expected KEY=VALUE`,
        'input', pair, 'key=value', 'e.g. --input orgId=1234abcd-...',
      );
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/** Read and parse `--inputs-file`, which holds a flat `{ name: value }` object. */
function readInputsFile(file: string): Record<string, string | number | boolean> {
  if (!fs.existsSync(file)) {
    throw new ValidationError(`Inputs file not found: ${file}`, 'inputs-file', file);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new ValidationError(
      `Inputs file is not valid JSON: ${errorMessage(error)}`,
      'inputs-file', file,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('Inputs file must contain a JSON object of { "inputName": value }', 'inputs-file', file);
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      throw new ValidationError(`Input "${k}" must be a string, number, or boolean (got ${t})`, 'inputs-file', file);
    }
  }
  return parsed as Record<string, string | number | boolean>;
}

/**
 * Resolve a template `name` to its id through the catalog list endpoint. The list
 * is visibility-scoped server-side, so this only ever sees templates the caller
 * may read. Matching is exact on `name` — the `name` query param is a filter, not
 * a unique lookup, so a fuzzy backend match must not silently instantiate a
 * DIFFERENT template than the one asked for.
 */
async function resolveTemplateByName(
  client: ReturnType<typeof createAuthenticatedClient>,
  name: string,
): Promise<PipelineTemplate> {
  const url = client.getConfig().api.pipelineTemplateUrl;
  const response = await client.get(url, { name, limit: 100 });
  const { items } = extractListResponse<PipelineTemplate>(response, 'templates');

  const exact = items.filter((t) => t.name === name);
  if (exact.length === 0) {
    throw new ValidationError(
      `No pipeline template named "${name}" is visible to you.`,
      'name', name, undefined,
      items.length > 0
        ? `Did you mean one of: ${items.slice(0, 10).map((t) => t.name).join(', ')}`
        : 'Load the sample catalog with deploy/bin/load-templates.sh, or pass --id.',
    );
  }
  // A name is unique per org, but the visible set spans your org + parent + the
  // system catalog, so the same name can legitimately appear more than once.
  // Refuse to guess — the wrong pick would silently synth someone else's body.
  if (exact.length > 1) {
    throw new ValidationError(
      `"${name}" matches ${exact.length} visible templates — pass --id to choose one.`,
      'name', name, undefined,
      `ids: ${exact.map((t) => t.id).join(', ')}`,
    );
  }
  return exact[0]!;
}

/**
 * Registers the `template instantiate` command.
 *
 * Renders a golden-path template into a concrete pipeline `props` document by
 * supplying its declared inputs. It **creates nothing** — the rendered props are
 * written to a file (or stdout) and go through the normal `pipeline create` path,
 * where compliance and quota still apply.
 *
 * @example
 * ```bash
 * pipeline-manager template instantiate --name react-javascript \
 *   --project react --organization AcmeCorp \
 *   --input orgId=1234abcd-... --output pipeline-props.json
 *
 * pipeline-manager pipeline create --file pipeline-props.json --deploy
 * ```
 */
export function instantiateTemplate(program: Command): void {
  withSslOptions(
    program
      .command('instantiate')
      .description('Render a pipeline template into concrete pipeline props (creates nothing)')
      .option('-n, --name <name>', 'Template name (resolved against the catalog you can see)')
      .option('-i, --id <id>', 'Template ID (skips the name lookup)')
      .requiredOption('-p, --project <project>', 'Project name for the pipeline this template will produce')
      .requiredOption('-o, --organization <organization>', 'Organization name for the pipeline')
      .option('--pipeline-name <name>', 'Pipeline name (defaults to <organization>-<project>-pipeline at synth)')
      .option('--input <key=value>', 'Template input, repeatable (e.g. --input orgId=1234abcd-...)', collectInput, [])
      .option('--inputs-file <file>', 'JSON file of { "inputName": value } — merged UNDER any --input flags')
      .option('--output <file>', 'Write the rendered props to a file (default: stdout)')
      .option('-f, --format <format>', 'Output format (json, yaml)', 'json'),
  )
    .option('--json', 'Print ONLY the rendered props as JSON (for piping); implies no decorative output', false)
    .action(async (options) => {
      // With --json (or props headed for stdout in any format) the payload IS the
      // output, so the banner must not land on stdout ahead of it and break piping.
      const toStdout = !options.output;
      const quiet = options.json || toStdout;
      const executionId = printCommandHeader('Instantiate Template', undefined, { quiet });

      try {
        if (!options.name && !options.id) {
          throw new ValidationError('Provide --name or --id to select a template', 'name');
        }
        if (options.name && options.id) {
          throw new ValidationError('Pass either --name or --id, not both', 'name');
        }
        // Only the round-trippable formats: the rendered props exist to be fed
        // back to `pipeline create --file`, and `table`/`csv` would flatten them
        // into something that can no longer be parsed as props.
        if (!['json', 'yaml'].includes(options.format)) {
          throw new ValidationError(
            `Unsupported --format "${options.format}" — rendered props must stay parseable`,
            'format', options.format, 'json|yaml',
          );
        }
        if (!quiet) printSslWarning(options.verifySsl);

        // --input flags win over --inputs-file so a file can hold shared defaults
        // that a single flag overrides on the command line.
        const inputs: Record<string, string | number | boolean> = {
          ...(options.inputsFile ? readInputsFile(options.inputsFile) : {}),
          ...parseInputPairs(options.input as string[]),
        };

        if (!quiet) {
          printInfo('Request parameters', {
            template: options.name ?? options.id,
            project: options.project,
            organization: options.organization,
            pipelineName: options.pipelineName ?? '(default)',
            inputs: Object.keys(inputs).length > 0 ? Object.keys(inputs).join(', ') : '(none)',
            output: options.output ?? '(stdout)',
          });
          console.log('');
          printSection('Rendering Template');
        }

        const client = createAuthenticatedClient(options);
        const templateUrl = client.getConfig().api.pipelineTemplateUrl;

        const startTime = Date.now();
        const spinner = quiet ? null : ora('Resolving template...').start();
        let templateId: string;
        let templateName: string | undefined;
        try {
          if (options.id) {
            templateId = options.id;
          } else {
            const template = await resolveTemplateByName(client, options.name);
            templateId = template.id;
            templateName = template.name;
          }
          spinner?.succeed(`Template resolved${templateName ? ` (${templateName})` : ''}`);
        } catch (error) {
          spinner?.fail('Template resolution failed');
          throw error;
        }

        const body: InstantiateTemplateRequest = {
          project: options.project,
          organization: options.organization,
          ...(options.pipelineName ? { pipelineName: options.pipelineName } : {}),
          ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        };

        const renderSpinner = quiet ? null : ora('Instantiating...').start();
        let rendered: InstantiateTemplateResponse | undefined;
        try {
          const response = await client.post(`${templateUrl}/${encodeURIComponent(templateId)}/instantiate`, body);
          // `props` is the identifier key: the envelope's data IS { props, ... }.
          rendered = extractSingleResponse<InstantiateTemplateResponse>(response, 'template', 'props');
          renderSpinner?.succeed('Template instantiated');
        } catch (error) {
          renderSpinner?.fail('Instantiate failed');
          throw error;
        }
        const duration = Date.now() - startTime;

        if (!rendered?.props) {
          printError('No props returned from API', { templateId });
          throw new Error(`Template ${templateId} rendered no props`);
        }
        const props = rendered.props as PipelineProps;

        // A leftover `{{ ... }}` in a *self-scope* field means an input was never
        // supplied and the placeholder would fail opaquely at synth. `pipeline.*`
        // tokens are expected here — they resolve at synth, not at instantiate.
        const unresolved = unresolvedSelfVars(props);
        if (unresolved.length > 0) {
          printWarning('Rendered props still contain unresolved placeholders', {
            vars: unresolved.join(', '),
            hint: 'Supply them with --input <name>=<value>',
          });
        }

        if (!quiet) {
          console.log('');
          printSection('Rendered Props');
          printKeyValue({
            'Template': green(bold(templateName ?? templateId)),
            'Project': props.project as string,
            'Organization': props.organization as string,
            'Pipeline Name': (props.pipelineName as string) ?? dim('(default at synth)'),
            'Vars': Object.keys((props.vars as Record<string, unknown>) ?? {}).join(', ') || dim('(none)'),
            'Stages': String(Array.isArray(props.stages) ? props.stages.length : 0),
          });
          printExecutionSummary(executionId, duration);
        }

        outputData(props, {
          format: options.json ? 'json' : options.format,
          file: options.output,
          silent: quiet,
        });

        if (options.output && !quiet) {
          console.log('');
          printSuccess('Pipeline props saved', { path: options.output });
          printInfo('Next step', {
            command: `pipeline-manager pipeline create --file ${options.output} --deploy`,
          });
          console.log(dim(`  ${cyan('Tip:')} instantiate only renders — nothing exists on the platform yet.`));
        }
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'instantiate-template', executionId, template: options.name ?? options.id },
        });
      }
    });
}

/**
 * Names of `{{ vars.X }}` placeholders still present in the rendered props' own
 * self-scope fields (`project`, `metadata.*`, `vars.*`) — i.e. inputs the caller
 * never supplied. `{{ pipeline.* }}` tokens are deliberately ignored: those are
 * synth-time references (e.g. the GitHub source token) and are SUPPOSED to
 * survive instantiation.
 */
function unresolvedSelfVars(props: PipelineProps): string[] {
  const found = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)/g)) found.add(m[1]!);
      return;
    }
    if (Array.isArray(value)) return value.forEach(scan);
    if (value && typeof value === 'object') return Object.values(value).forEach(scan);
  };
  scan(props.project);
  scan(props.metadata);
  scan(props.vars);
  return [...found];
}
