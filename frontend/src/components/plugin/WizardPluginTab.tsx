import { useState, useEffect, useRef, useCallback } from 'react';
import { Rocket, Save, CheckCircle, XCircle } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { useBuildStatus } from '@/hooks/useBuildStatus';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { Plugin } from '@/types';

/** Props for the WizardPluginTab component. */
interface WizardPluginTabProps {
  /** Whether the current user can create/publish public plugins (admin only). */
  canUploadPublic: boolean;
  /** Whether the tab inputs should be disabled. */
  disabled?: boolean;
  /** Callback when a plugin is successfully created or updated. */
  onCreated: () => void;
  /** Callback to close the parent modal. */
  onClose: () => void;
}

type Mode = 'create' | 'edit';

// Build-image plugin types the create path supports (it builds a Docker image
// from the supplied Dockerfile). ManualApprovalStep needs no build → use Upload.
const PLUGIN_TYPES = ['CodeBuildStep', 'ShellStep'] as const;
const COMPUTE_TYPES = ['SMALL', 'MEDIUM', 'LARGE', 'X2_LARGE'] as const;
const FAILURE_BEHAVIORS = ['fail', 'warn', 'ignore'] as const;

// Mirror the server / CLI `plugin validate` checks so a wizard-built plugin
// can't fail once it reaches the build.
const NAME_RE = /^[a-z0-9-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;

const DEFAULT_DOCKERFILE = [
  '# The base image provides the toolchain your commands need — keep it minimal and pinned.',
  'FROM alpine:3.20',
  '',
  '# TODO: install the tools your run commands invoke, e.g.:',
  '# RUN apk add --no-cache python3',
  '',
  'WORKDIR /workspace',
  '',
].join('\n');

/** Split a textarea into trimmed, non-empty lines (one command per line). */
function toLines(s: string): string[] {
  return s.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Parse `KEY=VALUE` lines into a record; ignores blank / malformed lines. */
function parseEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

/** Render an env record back into `KEY=VALUE` lines for the textarea. */
function envToText(env?: Record<string, string>): string {
  return env ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') : '';
}

/**
 * Manual, form-driven plugin builder. Two modes:
 *  - Create new  → fill the plugin spec; builds a container image via the
 *    `deployGeneratedPlugin` endpoint (same one the AI tab submits to).
 *  - Edit existing → pick a plugin from a filterable dropdown, prefill its
 *    settings, and save via `updatePlugin` (metadata/config only — name,
 *    version, and Dockerfile aren't editable without a rebuild).
 * The no-AI, no-offline-ZIP path.
 */
export default function WizardPluginTab({ canUploadPublic, disabled, onCreated, onClose }: WizardPluginTabProps) {
  const [mode, setMode] = useState<Mode>('create');

  // Shared spec fields.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [pluginType, setPluginType] = useState<string>('CodeBuildStep');
  const [computeType, setComputeType] = useState<string>('MEDIUM');
  const [keywords, setKeywords] = useState('');
  const [primaryOutputDirectory, setPrimaryOutputDirectory] = useState('');
  const [installCommands, setInstallCommands] = useState('');
  const [commands, setCommands] = useState('');
  const [envText, setEnvText] = useState('');
  const [dockerfile, setDockerfile] = useState(DEFAULT_DOCKERFILE);
  const [access, setAccess] = useState<'public' | 'private'>('private');
  // Edit-only settings (not accepted by the create/build path).
  const [timeout, setTimeoutVal] = useState<string>('');
  const [failureBehavior, setFailureBehavior] = useState<string>('fail');
  const [isActive, setIsActive] = useState(true);
  const [isDefault, setIsDefault] = useState(false);

  // Edit-mode plugin picker.
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [prefilling, setPrefilling] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Build queue tracking (create mode only) — same SSE flow as AI/Upload.
  const [requestId, setRequestId] = useState<string | null>(null);
  const { status: buildStatus, events, lastEvent } = useBuildStatus(requestId);
  const isBuilding = requestId !== null && buildStatus === 'building';
  const isWorking = saving || isBuilding || prefilling;

  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Monotonic token so a slower earlier selectPlugin() response can't prefill
  // the form after a newer selection (or a mode switch) has moved on.
  const selectGenRef = useRef(0);

  // Reset the shared spec fields to their create-mode defaults. Used on mode
  // switch so returning to "Create new" after editing plugin X doesn't leave
  // X's values pre-populated in the create form.
  const resetSpec = useCallback(() => {
    setName(''); setDescription(''); setVersion('1.0.0');
    setPluginType('CodeBuildStep'); setComputeType('MEDIUM');
    setKeywords(''); setPrimaryOutputDirectory(''); setInstallCommands('');
    setCommands(''); setEnvText(''); setDockerfile(DEFAULT_DOCKERFILE);
    setAccess('private'); setTimeoutVal(''); setFailureBehavior('fail');
    setIsActive(true); setIsDefault(false); setSelectedId('');
  }, []);

  // Load the plugin list the first time Edit mode is opened.
  const loadPlugins = useCallback(async () => {
    setPluginsLoading(true);
    try {
      const res = await api.listPlugins({ limit: '200' });
      if (res.success && res.data) setPlugins(res.data.plugins);
    } catch (err) {
      setError(formatError(err, 'Failed to load plugins'));
    } finally {
      setPluginsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === 'edit' && plugins.length === 0 && !pluginsLoading) void loadPlugins();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run when entering edit mode.
  }, [mode]);

  // Auto-complete on successful build (create mode).
  useEffect(() => {
    if (buildStatus === 'completed') {
      setSuccess(`Plugin "${name}" created successfully!`);
      onCreated();
      setTimeout(() => { if (mountedRef.current) onClose(); }, 2000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when buildStatus changes.
  }, [buildStatus]);

  // Prefill the form from a selected existing plugin (Edit mode).
  const selectPlugin = async (id: string) => {
    const gen = ++selectGenRef.current;
    setSelectedId(id);
    setError(null);
    setSuccess(null);
    if (!id) return;
    setPrefilling(true);
    try {
      const res = await api.getPluginById(id);
      if (!mountedRef.current || selectGenRef.current !== gen) return; // superseded / unmounted
      const p = res.success ? res.data?.plugin : undefined;
      if (!p) { setError('Could not load the selected plugin.'); return; }
      setName(p.name);
      setVersion(p.version);
      setDescription(p.description ?? '');
      setPluginType(p.pluginType);
      setComputeType(p.computeType);
      setKeywords((p.keywords ?? []).join(', '));
      setPrimaryOutputDirectory(p.primaryOutputDirectory ?? '');
      setInstallCommands((p.installCommands ?? []).join('\n'));
      setCommands((p.commands ?? []).join('\n'));
      setEnvText(envToText(p.env));
      setAccess(p.accessModifier === 'public' ? 'public' : 'private');
      setTimeoutVal(p.timeout != null ? String(p.timeout) : '');
      setFailureBehavior(p.failureBehavior ?? 'fail');
      setIsActive(p.isActive);
      setIsDefault(p.isDefault);
    } catch (err) {
      if (mountedRef.current && selectGenRef.current === gen) setError(formatError(err, 'Failed to load the selected plugin'));
    } finally {
      if (mountedRef.current && selectGenRef.current === gen) setPrefilling(false);
    }
  };

  const validateCreate = (): string | null => {
    const n = name.trim();
    if (!n) return 'Name is required.';
    if (!NAME_RE.test(n)) return 'Name must contain only lowercase letters, digits, and hyphens.';
    if (!SEMVER_RE.test(version.trim())) return 'Version must be a semantic version (e.g. 1.0.0).';
    if (toLines(commands).length === 0) return 'At least one run command is required.';
    if (!dockerfile.trim()) return 'A Dockerfile is required (this builds a container image for the plugin).';
    return null;
  };

  const handleCreate = async () => {
    const problem = validateCreate();
    if (problem) { setError(problem); return; }
    setError(null); setSuccess(null); setRequestId(null); setSaving(true);
    try {
      const env = parseEnv(envText);
      const response = await api.deployGeneratedPlugin({
        name: name.trim(),
        description: description.trim() || undefined,
        version: version.trim(),
        pluginType,
        computeType,
        keywords: keywords.trim() ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : undefined,
        primaryOutputDirectory: primaryOutputDirectory.trim() || undefined,
        installCommands: toLines(installCommands),
        commands: toLines(commands),
        env: Object.keys(env).length ? env : undefined,
        dockerfile,
        accessModifier: access,
      });
      if (response.statusCode === 202 && response.data?.requestId) {
        setRequestId(response.data.requestId);
      } else if (response.success) {
        setSuccess(`Plugin "${name}" created successfully!`);
        onCreated();
        setTimeout(() => { if (mountedRef.current) onClose(); }, 2000);
      }
    } catch (err: unknown) {
      setError(formatError(err, 'Failed to create plugin'));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (!selectedId) { setError('Select a plugin to edit.'); return; }
    if (toLines(commands).length === 0 && pluginType !== 'ManualApprovalStep') {
      setError('At least one run command is required.'); return;
    }
    setError(null); setSuccess(null); setSaving(true);
    try {
      const env = parseEnv(envText);
      const t = timeout.trim();
      const response = await api.updatePlugin(selectedId, {
        description: description.trim() || undefined,
        keywords: keywords.trim() ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : [],
        pluginType,
        computeType,
        primaryOutputDirectory: primaryOutputDirectory.trim() || null,
        env,
        installCommands: toLines(installCommands),
        commands: toLines(commands),
        accessModifier: access,
        isActive,
        isDefault,
        timeout: t ? Number(t) : null,
        failureBehavior: failureBehavior as 'fail' | 'warn' | 'ignore',
      });
      if (response.success) {
        setSuccess(`Plugin "${name}" updated successfully!`);
        onCreated();
        setTimeout(() => { if (mountedRef.current) onClose(); }, 1500);
      } else {
        setError(response.message || 'Failed to update plugin.');
      }
    } catch (err: unknown) {
      setError(formatError(err, 'Failed to update plugin'));
    } finally {
      setSaving(false);
    }
  };

  const filtered = plugins.filter((p) => {
    if (!filter.trim()) return true;
    const q = filter.trim().toLowerCase();
    return p.name.toLowerCase().includes(q)
      || (p.category ?? '').toLowerCase().includes(q)
      || (p.keywords ?? []).some((k) => k.toLowerCase().includes(q));
  });

  // Build in flight (create) — progress log is the active surface.
  if (requestId) {
    return (
      <div className="space-y-4">
        {success && (
          <div className="alert-success"><p className="flex items-center gap-2"><CheckCircle className="w-4 h-4" />{success}</p></div>
        )}
        {buildStatus === 'failed' && lastEvent && (
          <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3">
            <p className="text-sm text-red-800 dark:text-red-300 flex items-center gap-2"><XCircle className="w-4 h-4" />{lastEvent.message}</p>
          </div>
        )}
        {events.length > 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 max-h-64 overflow-y-auto">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Build Log</p>
            {events.map((event, i) => (
              <div key={i} className={`text-xs font-mono py-0.5 ${
                event.type === 'ERROR' ? 'text-red-600 dark:text-red-400' :
                event.type === 'COMPLETED' ? 'text-green-600 dark:text-green-400' :
                'text-gray-600 dark:text-gray-400'
              }`}>{event.message}</div>
            ))}
            {isBuilding && (
              <div className="flex items-center gap-2 mt-1 text-xs text-blue-600 dark:text-blue-400"><LoadingSpinner size="sm" /> Building Docker image...</div>
            )}
          </div>
        )}
      </div>
    );
  }

  const editing = mode === 'edit';

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 bg-gray-50 dark:bg-gray-800">
        {(['create', 'edit'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { if (isWorking || mode === m) return; setMode(m); resetSpec(); setError(null); setSuccess(null); }}
            disabled={isWorking}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              mode === m ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {m === 'create' ? 'Create new' : 'Edit existing'}
          </button>
        ))}
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400">
        {editing
          ? 'Pick a plugin and edit its settings. Name, version, and Dockerfile are fixed once built — to change those, create a new version.'
          : "Fill in the plugin spec and we'll build the container image and save it — no AI provider or offline packaging needed."}
      </p>

      <ErrorAlert message={error} />
      <SuccessAlert message={success} />

      {/* Edit mode: filterable plugin picker */}
      {editing && (
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Filter" hint="name, category, or keyword">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search plugins…" disabled={isWorking} />
          </FormField>
          <FormField label="Plugin" hint={pluginsLoading ? 'Loading…' : `${filtered.length} available`}>
            <Select value={selectedId} onChange={(e) => void selectPlugin(e.target.value)} disabled={isWorking || pluginsLoading}>
              <option value="">Select a plugin…</option>
              {filtered.map((p) => (
                <option key={p.id} value={p.id}>{p.name} v{p.version}{p.accessModifier === 'public' ? ' · public' : ''}</option>
              ))}
            </Select>
          </FormField>
        </div>
      )}

      {/* The spec form is shown for Create always, and for Edit once a plugin is selected. */}
      {(!editing || selectedId) && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Name" hint={editing ? 'not editable' : 'lowercase, digits, hyphens'}>
              <Input value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="my-linter" disabled={disabled || isWorking || editing} />
            </FormField>
            <FormField label="Version" hint={editing ? 'not editable' : undefined}>
              <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" disabled={disabled || isWorking || editing} />
            </FormField>
          </div>

          <FormField label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this plugin does" disabled={disabled || isWorking} />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Plugin type">
              <Select value={pluginType} onChange={(e) => setPluginType(e.target.value)} disabled={disabled || isWorking}>
                {PLUGIN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                {/* Preserve an existing plugin's type even if it isn't a build type we create. */}
                {editing && !PLUGIN_TYPES.includes(pluginType as (typeof PLUGIN_TYPES)[number]) && <option value={pluginType}>{pluginType}</option>}
              </Select>
            </FormField>
            <FormField label="Compute type">
              <Select value={computeType} onChange={(e) => setComputeType(e.target.value)} disabled={disabled || isWorking}>
                {COMPUTE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Keywords" hint="comma-separated (optional)">
              <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="quality, lint" disabled={disabled || isWorking} />
            </FormField>
            <FormField label="Primary output directory" hint="optional">
              <Input value={primaryOutputDirectory} onChange={(e) => setPrimaryOutputDirectory(e.target.value)} placeholder="dist" disabled={disabled || isWorking} />
            </FormField>
          </div>

          <FormField label="Install commands" hint="one per line, run before the build (optional)">
            <Textarea className="font-mono text-xs" rows={2} value={installCommands} onChange={(e) => setInstallCommands(e.target.value)} placeholder={'npm ci'} disabled={disabled || isWorking} />
          </FormField>

          <FormField label="Run commands" hint="one per line, required">
            <Textarea className="font-mono text-xs" rows={3} value={commands} onChange={(e) => { setCommands(e.target.value); setError(null); }} placeholder={'npm run build'} disabled={disabled || isWorking} />
          </FormField>

          <FormField label="Environment" hint="KEY=VALUE, one per line (optional)">
            <Textarea className="font-mono text-xs" rows={2} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={'NODE_ENV=production'} disabled={disabled || isWorking} />
          </FormField>

          {/* Dockerfile — create only (editing it would need a rebuild). */}
          {!editing && (
            <FormField label="Dockerfile" hint="defines the container image the commands run in">
              <Textarea className="font-mono text-xs" rows={8} value={dockerfile} onChange={(e) => { setDockerfile(e.target.value); setError(null); }} disabled={disabled || isWorking} />
            </FormField>
          )}

          {/* Other settings — edit only (the create/build path doesn't accept these). */}
          {editing && (
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Timeout (minutes)" hint="blank = default">
                <Input type="number" min={0} value={timeout} onChange={(e) => setTimeoutVal(e.target.value)} placeholder="10" disabled={isWorking} />
              </FormField>
              <FormField label="Failure behavior">
                <Select value={failureBehavior} onChange={(e) => setFailureBehavior(e.target.value)} disabled={isWorking}>
                  {FAILURE_BEHAVIORS.map((b) => <option key={b} value={b}>{b}</option>)}
                </Select>
              </FormField>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <Checkbox checked={isActive} onChange={(e) => setIsActive(e.target.checked)} disabled={isWorking} /> Active
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <Checkbox checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} disabled={isWorking} /> Default for its category
              </label>
            </div>
          )}

          <div className="border-t border-gray-200 dark:border-gray-700 pt-4 flex items-center justify-between">
            <FormField label="Access Level" hint={!canUploadPublic ? 'Only admins can create/publish public plugins' : undefined}>
              <Select value={access} onChange={(e) => setAccess(e.target.value as 'public' | 'private')} className="!w-auto" disabled={isWorking || !canUploadPublic}>
                <option value="private">Private (Organization only)</option>
                {(canUploadPublic || access === 'public') && <option value="public">Public (Available to all)</option>}
              </Select>
            </FormField>

            {editing ? (
              <Button onClick={handleSave} disabled={disabled || isWorking || !selectedId}>
                {saving ? <><LoadingSpinner size="sm" className="mr-2" />Saving…</> : <><Save className="w-4 h-4 mr-2" />Save changes</>}
              </Button>
            ) : (
              <Button onClick={handleCreate} disabled={disabled || isWorking}>
                {saving ? <><LoadingSpinner size="sm" className="mr-2" />Queueing build…</> : <><Rocket className="w-4 h-4 mr-2" />Create Plugin</>}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
