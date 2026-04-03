# frontend

Next.js dashboard for the pipeline-builder platform. Provides pipeline management, AI-powered generation from Git repositories, plugin management, and quota monitoring.

## Pages

| Path | Description |
|------|-------------|
| `/dashboard` | Home page with Git URL hero input, recent pipelines, and quota summary |
| `/dashboard/pipelines` | Pipeline list with single search bar and collapsible advanced filters |
| `/dashboard/pipelines/[id]` | Pipeline detail view |
| `/dashboard/plugins` | Plugin list with single search bar and collapsible advanced filters |
| `/dashboard/plugins/[id]` | Plugin detail view |
| `/dashboard/quotas` | Quota management |
| `/dashboard/settings` | User and organization settings |

## Key Components

### Pipeline Creation

- **CreatePipelineModal** — Three-tab modal: Git URL (default), Upload, Wizard
- **GitUrlTab** — Accepts a repo URL, analyzes it via backend (GitHub, GitLab, Bitbucket), streams AI-generated pipeline config. Includes editable Project/Organization fields, provider/model selection, and auto-plugin creation status.
- **UploadConfigTab** — Paste or upload JSON pipeline config
- **FormBuilderTab** — Multi-step wizard for manual pipeline configuration

### Plugin Creation

- **CreatePluginModal** — Two-tab modal: AI Builder (default), Upload

### Dashboard Home

The home page features a Git URL hero input as the primary CTA. Entering a URL and clicking "Generate" opens the CreatePipelineModal on the Git URL tab with the URL pre-filled and auto-generation started.

Secondary actions: "Upload config" and "Create manually" open the modal on their respective tabs.

## AI Provider Selection

The `useAIProviders` hook fetches available providers from the backend. Configured providers are sorted first. Cloud providers (Anthropic, OpenAI, Google, xAI, Amazon Bedrock) require API keys configured on the server or provided per-request.

## Simplified Filters

Both the Pipelines and Plugins pages use a single search bar with a collapsible "Filters" panel for advanced filtering. The filter count badge shows how many advanced filters are active.
