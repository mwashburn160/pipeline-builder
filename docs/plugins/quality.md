# Code Quality Plugins

Linting, formatting, static analysis, and code coverage reporting.

```mermaid
flowchart LR
    Code[Source Code] --> LintFmt[Lint & Format]
    Code --> Cov[Coverage]
    Cov --> Report[Coverage Reporting]

    LintFmt --> eslint & prettier & checkstyle & shellcheck & golangci-lint
    LintFmt --> clippy & rustfmt & rubocop & ruff & mypy
    LintFmt --> dotnet-format & roslyn-analyzers & typescript-check
    Code --> StaticAnalysis[Static Analysis]
    StaticAnalysis --> jacoco & spotbugs
    Report --> codecov & codacy
```

## Lint & Format

| Plugin | Language | Compute | Secrets | Key Env Vars |
|--------|----------|---------|---------|--------------|
| eslint | JS/TS | SMALL | None | `NODE_VERSION`, `ESLINT_FORMAT`, `ESLINT_MAX_WARNINGS` |
| prettier | JS/TS/CSS/HTML | SMALL | None | `NODE_VERSION`, `PRETTIER_GLOB` |
| checkstyle | Java | SMALL | None | `CHECKSTYLE_VERSION`, `CHECKSTYLE_CONFIG`, `JAVA_VERSION` |
| shellcheck | Bash/sh/zsh | SMALL | None | `SHELLCHECK_VERSION`, `SHELLCHECK_SEVERITY`, `SHELLCHECK_FORMAT` |
| golangci-lint | Go | MEDIUM | None | `GOLANGCI_LINT_VERSION`, `GOLANGCI_LINT_CONFIG` |
| clippy | Rust | SMALL | None | `RUST_VERSION`, `CLIPPY_FLAGS` |
| rustfmt | Rust | SMALL | None | `RUST_VERSION`, `RUSTFMT_FLAGS` |
| rubocop | Ruby | SMALL | None | `RUBY_VERSION`, `RUBOCOP_CONFIG` |
| ruff | Python | SMALL | None | `PYTHON_VERSION`, `RUFF_CONFIG`, `RUFF_FORMAT` |
| mypy | Python | SMALL | None | `PYTHON_VERSION`, `MYPY_CONFIG`, `MYPY_STRICT` |
| dotnet-format | .NET | SMALL | None | `DOTNET_VERSION`, `FORMAT_SEVERITY` |
| roslyn-analyzers | .NET | SMALL | None | `DOTNET_VERSION`, `ANALYZER_SEVERITY` |
| typescript-check | TypeScript | SMALL | None | `NODE_VERSION`, `TSC_FLAGS` |

## Static Analysis

| Plugin | Language | Compute | Secrets | Key Env Vars |
|--------|----------|---------|---------|--------------|
| jacoco | Java | MEDIUM | None | `JAVA_VERSION`, `COVERAGE_THRESHOLD`, `BUILD_TOOL` |
| spotbugs | Java | MEDIUM | None | `JAVA_VERSION`, `SPOTBUGS_EFFORT`, `BUILD_TOOL` |

## Coverage Reporting

| Plugin | Compute | Secrets | Key Env Vars |
|--------|---------|---------|--------------|
| codecov | SMALL | `CODECOV_TOKEN` | `CODECOV_FLAGS`, `CODECOV_FILE` |
| codacy | SMALL | `CODACY_PROJECT_TOKEN` | `CODACY_LANGUAGE` |
