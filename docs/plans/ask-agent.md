# Plan: "Ask" Agent — in-app chat for platform how-to + creation

## Goal

An in-app **chat panel** ("Ask") that does two things in one surface:

1. **Explain** — answer platform functionality / how-to questions, grounded in the
   existing in-app help corpus, with deep-links to the right dashboard page.
2. **Do** — create **pipelines, templates, and plugins** from natural language, by
   calling the platform's existing generation + CRUD APIs as **tools**.

Driven by a **tool-model** (a tool-calling-capable LLM) that can be sourced from a
**Docker model image** (self-hosted) or a cloud provider.

---

## The tool-model (central design decision)

The agent is only as good as the model's **tool-calling** (function-calling)
ability — that's what turns "create a pipeline that lints and deploys on push"
into an actual `create_pipeline` call. Two sourcing paths, both already reachable
through the existing multi-provider registry (`packages/ai-core`):

| Path | How | Best for |
|---|---|---|
| **Docker model image** (self-hosted) | Docker Model Runner (`docker model run ai/…`) or Ollama / vLLM, serving a **tool-capable** model (e.g. Qwen 2.5 Coder 32B, Llama 3.3 70B). Exposes an **OpenAI-compatible** endpoint. | Data stays on-prem; no per-token cloud cost |
| **Cloud** | Claude 5 / GPT-5.6 via the existing anthropic/openai providers | Strongest tool-calling reliability |

**Prerequisite gap (Phase 0):** the `@ai-sdk/openai-compatible` adapter is already
a dependency but is **not registered** in `provider-registry.ts`. Wiring it (with a
configurable base URL) is what lets the platform point at a Docker model image.

**Routing:** small local models answer *how-to* well but are unreliable at
multi-step tool-calling. So the agent routes by task:
- **Explain** → cheap/local model is fine.
- **Do** (tool-calling) → a large local model **or** a cloud model. The registry
  makes per-task model selection trivial.

---

## Architecture

```
┌──────────────┐   chat/SSE   ┌───────────────────┐   OpenAI-compat   ┌────────────────────┐
│  Dashboard   │◀────────────▶│   ask (service)   │◀─────────────────▶│  Docker model image │
│  Ask panel   │              │  tool-calling loop │                   │ (Model Runner/Ollama)│
└──────────────┘              └─────────┬─────────┘                   └────────────────────┘
                                        │ internal APIs (service token, org-scoped)
                          ┌─────────────┼──────────────┬──────────────┐
                          ▼             ▼              ▼              ▼
                    api/pipeline   api/plugin   pipeline-templates   help corpus
                    (generate/CRUD)(generate)   (CRUD)               (grounding)
```

- **`ask` service** — new container. Runs the tool-calling loop, streams tokens over
  SSE, holds conversation state, calls internal APIs as tools with a per-request
  org-scoped service token. Mirrors the existing service layout + auth.
- **Docker model image** — the tool-model, an OpenAI-compatible endpoint.
- **Frontend Ask panel** — slide-over (or `/dashboard/ask`), reusing the existing
  SSE + chat plumbing (message service / `sseManager`).

---

## Phases

### Phase 0 — Enable local / tool models (small, foundational)
- Register an **`openai-compatible`** provider in `packages/ai-core/provider-registry.ts`
  with a configurable **base URL** + model id (env / per-org AI config).
- Add it to `AI_PROVIDER_CATALOG` (+ frontend mirror) so it's selectable.
- Result: the platform can point at **any** Docker model image / Ollama endpoint.
- Tests: registry resolves a model against the configured base URL.

### Phase 1 — Read-only "Ask" chat (Explain)
- **`ask` service** skeleton: chat endpoint + SSE streaming, tool-calling loop with
  a single read tool `answer_how_to`.
- **Grounding:** retrieval over the in-app help corpus (`frontend/src/lib/help/*`)
  + `docs/` — start keyword/BM25, upgrade to embeddings later.
- **Frontend Ask panel:** streaming chat UI; answers include **deep-links** to the
  relevant dashboard page.
- **No write tools** — can't mutate anything. Useful on its own, low-risk.

### Phase 2 — Tools (Do)
- Write tools, each wrapping an existing API and returning a **preview for confirm**
  before committing:
  - `create_pipeline(prompt|spec)` → `api/pipeline` generation + CRUD
  - `create_template(...)` → `pipeline-templates` CRUD
  - `create_plugin(prompt|spec)` → `api/plugin` generation
  - read helpers: `list_pipelines`, `inspect_pipeline`, … so the model can reason
    about existing resources
- **Confirm gate:** every write tool surfaces a diff/preview in the chat; the user
  confirms before the agent commits. No silent mutations.

### Phase 3 — The Docker model image in deploy
- Add a **model container** (Docker Model Runner or Ollama) to `deploy/*`
  (compose + k8s), serving a tool-capable model on an OpenAI-compatible port.
- Wire the `ask` service's provider config at it. Document GPU/RAM requirements
  (creation-grade tool-calling needs a large model).

### Phase 4 — Hardening
- **Tenancy:** service token scoped to the calling user's org; write tools respect
  RBAC permissions + quotas; **never** cross-tenant.
- **Audit:** every tool invocation (esp. writes) → the audit log.
- **Rate limits:** per-org budget on the `ask` endpoint (LLM + tool calls).
- **Entitlement:** gate behind an AI/`advanced` feature entitlement (billing), like
  `advanced_reporting`. Support BYO-key and platform-hosted model.
- **Safety:** writes go through soft-delete/undo where the API supports it.

---

## Tool schemas (what the tool-model can call)

| Tool | Kind | Wraps | Notes |
|---|---|---|---|
| `answer_how_to(query)` | read | help corpus retrieval | returns answer + deep-links |
| `list_resources(kind, filter)` | read | pipeline/plugin/template list | lets the model ground on real state |
| `inspect(kind, id)` | read | detail endpoints | |
| `create_pipeline(promptOrSpec)` | **write** | `api/pipeline` generate + CRUD | preview → confirm → commit |
| `create_template(spec)` | **write** | `pipeline-templates` | preview → confirm |
| `create_plugin(promptOrSpec)` | **write** | `api/plugin` generate | preview → confirm |

All writes are **two-step**: the tool returns a draft/preview; commit happens only
after explicit user confirmation in the chat.

---

## What's ready vs. to build

**Ready (reuse):**
- Multi-provider LLM registry (`packages/ai-core`) — now on Claude 5 / GPT-5.6 / Gemini 3 / Grok 4.
- `@ai-sdk/openai-compatible` dependency (for local Docker models) — present, unwired.
- Pipeline + plugin **generation services**; template CRUD.
- In-app **help corpus** (`frontend/src/lib/help/*`) — grounding source.
- **SSE streaming** (message service / `sseManager`) — chat transport.
- Per-org AI provider config (BYO keys) + a Docker-based plugin runtime as precedent.

**To build:**
- Phase 0 registry wiring (small).
- The `ask` service (tool loop + SSE + tool implementations).
- The Ask chat panel (frontend).
- The Docker model image deploy entry.
- Grounding index + entitlement/audit/rate-limit wiring.

---

## Risks / open questions

- **Tool-calling reliability on local models** — small models struggle; creation may
  need a large local model or a cloud fallback. (Explain works on small models.)
- **GPU/RAM cost** of self-hosting a creation-grade model.
- **Grounding freshness** — the help corpus must stay in sync with features.
- **Write safety** — the confirm gate + soft-delete/undo are load-bearing.
- **Monetization shape** — platform-hosted model vs. BYO-key vs. self-hosted Docker
  model; which tiers get the agent.

---

## Recommended sequencing

Ship **Phase 0 + Phase 1** first (openai-compatible wiring + read-only Ask chat).
It's genuinely useful, can't mutate anything, proves the whole plumbing (chat UI,
streaming, grounding, tool-model wiring — including a Docker model image), and de-
risks the model-quality question before any write tools exist. Then layer Phase 2.
