# Pipeline template samples

Golden-path **pipeline templates** — parameterized starting points, not pipelines.
Each folder holds one `template.json` (the body POSTed to
`/api/pipeline-templates`) plus a README covering its stages and prerequisites.

| Template | Language | Demo repository | Stages |
|----------|----------|-----------------|--------|
| [react-javascript](react-javascript/) | JS/TS | sitek94/vite-deploy-demo | Build, Security |
| [spring-boot-java](spring-boot-java/) | Java | dstar55/docker-hello-world-spring-boot | Build |
| [django-python](django-python/) | Python | django-ve/django-helloworld | Security |
| [gin-golang](gin-golang/) | Go | lamhotsimamora/Hello-World-Golang-Gin | Build, Security |
| [axum-rust](axum-rust/) | Rust | ChiefTechDev/Rust-Axum-Hello-World | Build, Security |
| [rails-ruby](rails-ruby/) | Ruby | m9rc1n/hello-world-rails | Security |
| [aspnetcore-dotnet](aspnetcore-dotnet/) | C#/.NET | Azure-Samples/dotnetcore-docs-hello-world | Build, Security |

## Anatomy of a `template.json`

| Field | Meaning |
|-------|---------|
| `name` | Unique per org — the handle you look the template up by |
| `description`, `keywords`, `category` | Catalog metadata for search and grouping |
| `visibility` | `private` \| `org` \| `public`. The loader forces `public` so the seeded catalog is readable from every org |
| `inputs[]` | Declared parameters. Each becomes a `vars.<name>` key on the generated pipeline |
| `props` | The pipeline body (`BuilderProps`) with `{{ pipeline.vars.* }}` placeholders |

`props` deliberately omits `project`, `organization`, and `vars` — instantiation
supplies all three from the request, so there is nothing to hand-edit.

Every sample here declares exactly one input, **`orgId`**, because it is the one
value the pipeline body genuinely resolves at synth time: the GitHub source
`token` reads `secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token`.
The source `repo`/`branch` are **not** synth-templatable (only `token` is), so
they stay literal — fork a template and edit `props.synth.source.options` to point
at your own repository.

## Loading

```bash
cd deploy
bash bin/load-templates.sh              # POSTs each template to the platform
bash bin/load-templates.sh --dry-run    # validate the files, upload nothing
```

Templates land in the reserved `system` org as `public`, so every logged-in org
sees them in the golden-path catalog. A name that already exists comes back as
HTTP 409 and is reported as `SKIP` — re-running the loader is safe.

## Instantiating

```bash
pipeline-manager template instantiate \
  --name react-javascript \
  --project react --organization AcmeCorp \
  --input orgId=<your-org-id> \
  --output pipeline-props.json

pipeline-manager pipeline create --file pipeline-props.json --deploy --region us-east-1
```

`template instantiate` only *renders* — it creates nothing. The returned props go
through the normal create path, so compliance and quota still apply. Useful flags:

| Flag | Purpose |
|------|---------|
| `--name` / `--id` | Select the template. `--name` resolves against the catalog you can see and refuses to guess if the name is missing or ambiguous |
| `--input k=v` | Repeatable. Supplies one declared input; values are coerced to their declared type server-side |
| `--inputs-file <f>` | A JSON `{ "inputName": value }` object, merged **under** any `--input` flags |
| `--output <f>` | Write the props to a file. Without it they go to stdout |
| `--json` | Print only the props, no decorative output — for piping into `jq` |

See [`../ci/`](../ci/) for the same flow wired into GitHub Actions, GitLab CI, and
CircleCI.
