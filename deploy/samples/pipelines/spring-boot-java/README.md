# Spring Boot Java Pipeline

**Repository:** [spring-projects/spring-boot](https://github.com/spring-projects/spring-boot)
**Language:** Java
**Build Tool:** Gradle

## Overview

A CI/CD pipeline for Spring Boot, the industry-standard Java application framework. Includes building, testing with coverage, code quality analysis, security scanning, and Maven artifact publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Build** | java-corretto | Compile with Gradle on Java 17 |
| **Test** | java-corretto, jacoco | Test execution and 70% coverage verification |
| **Lint** | checkstyle, spotbugs | Code style enforcement and bug pattern detection |
| **Security** | semgrep, dependency-check, git-secrets | SAST, dependency scanning, and secret detection |
| **Publish** | maven-publish | Artifact publishing |

## Pipeline Flow

```
Source (GitHub) → Synth → Build → Test → Lint → Security → Publish
```

## Key Configuration

- **Java 17** on Amazon Corretto
- **MEDIUM compute** (7 GB / 4 vCPU) for Gradle builds
- **JaCoCo** with 70% coverage threshold
- **OWASP Dependency Check** fails on CVSS score >= 7
- **SpotBugs** runs with `warn` failure behavior for advisory reporting
