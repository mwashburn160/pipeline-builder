# frontend

Next.js dashboard for the pipeline-builder platform. Provides pipeline management, AI-powered generation from Git repositories, plugin management, and quota monitoring.

## Pages

| Path | Description |
|------|-------------|
| `/dashboard` | Home page with Git URL hero input, recent pipelines, and quota summary |
| `/dashboard/pipelines` | Pipeline list with single search bar and collapsible advanced filters |
| `/dashboard/pipelines/[id]` | Pipeline detail view |
| `/dashboard/plugins` | Plugin list with single search bar and collapsible advanced filters; plugin details open in an in-page view modal |
| `/dashboard/quotas` | Quota management |
| `/dashboard/settings` | User and organization settings |

The table above lists the core pipeline and plugin surfaces. The dashboard also includes additional pages for organizations, users, teams, invitations, billing, audit, observability, registry, and platform administration.

## Key Components

### Pipeline Creation

- **CreatePipelineModal** — Three-tab modal: Git URL (default), Upload, Wizard
- **GitUrlTab** — Accepts a repo URL, analyzes it via backend (GitHub, GitLab, Bitbucket, and self-hosted Git URLs), streams AI-generated pipeline config. Includes editable Project/Organization fields, provider/model selection, and auto-plugin creation status.
- **UploadConfigTab** — Paste or upload JSON pipeline config
- **FormBuilderTab** — Multi-step wizard for manual pipeline configuration

### Plugin Creation

- **CreatePluginModal** — Two-tab modal: AI Builder (default), Upload

### Dashboard Home

The home page features a Git URL hero input as the primary CTA. Entering a URL and clicking "Generate" opens the CreatePipelineModal on the Git URL tab with the URL pre-filled and auto-generation started.

Secondary actions: "Upload config" and "Create manually" open the modal on their respective tabs.

## AI Provider Selection

The `useAIProviders` hook merges providers from three sources — server environment variables, saved per-organization API keys, and the full provider catalog — so the dropdown always shows every known provider. Configured providers are sorted first; unconfigured ones are listed alphabetically after them and auto-expand a custom API key field when selected. Supported cloud providers are Anthropic, OpenAI, Google, xAI, and Amazon Bedrock; each requires an API key configured on the server, saved at the organization level, or provided per-request.

## Simplified Filters

Both the Pipelines and Plugins pages use a single search bar with a collapsible "Filters" panel for advanced filtering. The search input is focusable via the `/` keyboard shortcut, and a filter count badge shows how many advanced filters are active.
