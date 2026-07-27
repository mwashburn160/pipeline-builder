// Row shapes for the reports page. These mirror the (inline, non-exported)
// response-row types in `@/lib/api/domains/reporting`; kept as a local shared
// module so the page and its extracted tab components agree on the same types.

// ─── Pipeline ───────────────────────────────────────────
/** One success-rate/timeline bucket. Also used for the Success Rate Trend (same shape). */
export interface TimelineEntry { period: string; succeeded: number; failed: number; canceled: number; success_pct: number }
export interface DurationStat { id: string; project: string; pipeline_name: string | null; avg_ms: number; min_ms: number; max_ms: number; p95_ms: number; executions: number }
export interface StageFailure { stage_name: string; failures: number; total: number; failure_pct: number }
export interface StageBottleneck { id: string; pipeline_name: string | null; stage_name: string; avg_ms: number; max_ms: number }
export interface ErrorEntry { error_pattern: string; occurrences: number; affected_pipelines: number; last_seen: string }
export interface ActionFailure { action_name: string; failures: number; total: number; failure_pct: number }

// ─── Plugin ─────────────────────────────────────────────
export interface PluginSummary { total: number; active: number; inactive: number; public: number; private: number; unique_names: number }
export interface PluginVersion { name: string; version_count: number; latest_version: string; has_default: boolean }
export interface BuildSuccessEntry { period: string; succeeded: number; failed: number; success_pct: number }
export interface BuildDurationStat { plugin_name: string; avg_ms: number; max_ms: number; builds: number }
export interface BuildFailure { plugin_name: string; error_message: string; occurrences: number; last_seen: string }
export interface PluginDistribution { plugin_type: string; compute_type: string; count: number }
