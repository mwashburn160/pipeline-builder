# deploy-contracts

Contract tests for the `deploy/` tree: the Kubernetes manifests of every
target, docker-compose, the four per-target `.env.example` files, the shared shell
tooling, the observability configs and the CI workflows that check them. They
read files only — no service code — and run whenever anything under `deploy/`
changes (this project's Nx inputs).

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest     # from this directory
npx nx run deploy-contracts:test                    # from the repo root
```

`src/index.ts` holds the shared readers (repo root, YAML documents, the target
lists).
