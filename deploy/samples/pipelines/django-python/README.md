# Django Python Pipeline

**Repository:** [django/django](https://github.com/django/django)
**Language:** Python
**Build Tool:** pip / setuptools

## Overview

A CI/CD pipeline for Django, the popular Python web framework. Includes testing with coverage, linting with Ruff, security scanning with Bandit, and PyPI publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Test** | python-pytest, coverage-py | Test execution and 75% coverage threshold |
| **Lint** | ruff, mypy | Fast linting/formatting and static type checking |
| **Security** | bandit, git-secrets | Python SAST and secret detection |
| **Publish** | pypi-publish | PyPI publishing |

## Pipeline Flow

```
Source (GitHub) → Synth → Test → Lint → Security → Publish
```

## Key Configuration

- **Python 3.12** across all stages
- **Ruff** for fast linting and formatting (replaces flake8 + black + isort)
- **mypy** with django-stubs for type checking (advisory mode)
- **Bandit** for Python-specific security analysis
- **75% coverage threshold** enforced via coverage-py
