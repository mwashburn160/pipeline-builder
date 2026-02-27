# Django Python Pipeline

**Repository:** [django/django](https://github.com/django/django)
**Language:** Python
**Build Tool:** pip / setuptools

## Overview

A production-ready CI/CD pipeline for Django, the popular Python web framework. Features modern Python tooling with Ruff for linting, multi-version testing (Python 3.11 + 3.12), security scanning with Bandit and Safety, and PyPI publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Lint** | ruff, mypy | Fast linting/formatting and static type checking |
| **Unit-Test** | python-pytest (x2) | Test execution on Python 3.12 (primary) and 3.11 (compat) |
| **Coverage** | coverage-py | Code coverage with 75% threshold |
| **Security** | bandit, safety, git-secrets | SAST, dependency vulnerabilities, and secret detection |
| **Package** | twine-publish, mkdocs-build | PyPI publishing and documentation build |

## Pipeline Flow

```
Source (GitHub) → Synth → Lint → Unit-Test → Coverage → Security → Package
```

## Key Configuration

- **Python 3.12** as primary version, with **Python 3.11** compatibility testing
- **Ruff** for fast linting and formatting (replaces flake8 + black + isort)
- **mypy** with django-stubs for type checking (advisory mode)
- **Bandit** for Python-specific security analysis
- **Safety** checks for known vulnerabilities in dependencies
- **MkDocs** documentation build verification
