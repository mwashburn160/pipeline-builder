# Django Python Pipeline

**Repository:** [django/django](https://github.com/django/django)
**Language:** Python
**Build Tool:** pip / setuptools

## Overview

A CI/CD pipeline for Django, the popular Python web framework. Includes testing with coverage, linting with Ruff, security scanning with Bandit, and PyPI publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **UnitTests** | `python-pytest`, `coverage-py` | Run the test suite with coverage |
| **CodeQuality** | `ruff`, `mypy` | Code style enforcement and static analysis |
| **SecurityScan** | `bandit`, `git-secrets` | Security scanning (SAST, dependencies, secrets) |

## Pipeline Flow

```
Source -> Synth -> UnitTests -> CodeQuality -> SecurityScan
```

## Key Configuration

- **Python 3.12** across all stages
- **Ruff** for fast linting and formatting (replaces flake8 + black + isort)
- **mypy** with django-stubs for type checking (advisory mode)
- **Bandit** for Python-specific security analysis
- **75% coverage threshold** enforced via coverage-py
