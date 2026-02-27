# Spring Boot Java Pipeline

**Repository:** [spring-projects/spring-boot](https://github.com/spring-projects/spring-boot)
**Language:** Java
**Build Tool:** Gradle

## Overview

An enterprise-grade CI/CD pipeline for Spring Boot, the industry-standard Java application framework. Features multi-JDK compatibility testing (Java 17 + 21), static analysis, security scanning with OWASP, and Maven artifact publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Quality** | checkstyle, spotbugs | Code style enforcement and bug pattern detection |
| **Build-Test** | java-corretto (x2) | Build and test on Java 17 (primary) and Java 21 (compat) |
| **Coverage** | jacoco | Code coverage with 70% threshold verification |
| **SAST** | sonarcloud, owasp-dependency-check | Static analysis and dependency vulnerability scanning |
| **Publish** | maven-publish, gradle-build-scan | Artifact publishing and build analytics |

## Pipeline Flow

```
Source (GitHub) → Synth → Quality → Build-Test → Coverage → SAST → Publish
```

## Key Configuration

- **Java 17** as primary JDK, with **Java 21** compatibility testing
- **MEDIUM compute** (7 GB / 4 vCPU) for build stages to handle large Gradle builds
- **JaCoCo** with 70% coverage threshold
- **OWASP Dependency Check** fails on CVSS score >= 7
- **SpotBugs** and **OWASP** run with `warn` failure behavior for advisory reporting
- **Gradle Build Scan** runs with `ignore` failure behavior (optional analytics)
