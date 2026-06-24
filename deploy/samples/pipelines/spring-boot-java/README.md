# Spring Boot Java Pipeline

**Repository:** [spring-projects/spring-boot](https://github.com/spring-projects/spring-boot)
**Language:** Java
**Build Tool:** Gradle

## Overview

A CI/CD pipeline for Spring Boot, the industry-standard Java application framework. Includes building, testing with coverage, code quality analysis, security scanning, and Maven artifact publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **BuildAndPackage** | `java-corretto` | Compile and package the application |
| **UnitTests** | `jacoco` | Run the test suite with coverage |
| **CodeQuality** | `checkstyle`, `spotbugs` | Code style enforcement and static analysis |
| **SecurityScan** | `semgrep`, `dependency-check` | Security scanning (SAST, dependencies, secrets) |
| **PackageImage** | `docker-build` | Build the container image (repo source + BuildAndPackage artifact) |

## Pipeline Flow

```
Source -> Synth -> BuildAndPackage -> UnitTests -> CodeQuality -> SecurityScan -> PackageImage
```

## Key Configuration

- **Java 17** on Amazon Corretto
- **LARGE compute** (15 GB / 8 vCPU) for the Gradle build step (`GRADLE_OPTS=-Xmx8g`)
- **JaCoCo** with 70% coverage threshold
- **OWASP Dependency Check** fails on CVSS score >= 7
- **SpotBugs** runs with `warn` failure behavior for advisory reporting

## Container Packaging

The **PackageImage** stage (`docker-build`) builds a container image from the
repository **source** (the `Dockerfile` and build context come from the repo,
not from a prior stage). To avoid rebuilding the app inside the image, the
compiled output from **BuildAndPackage** (`java-corretto`) is attached as an
additional input and mounted at **`build-artifact/`**.

Your `Dockerfile` should `COPY` the Gradle/Maven jar from that mount instead of recompiling:

```dockerfile
# build-artifact/ holds the BuildAndPackage output; the repo is the build context
COPY build-artifact/build/libs/*.jar app.jar
```

> The mount path mirrors the producer's output layout (`java-corretto`). Adjust the
> `COPY` source to match your project's actual artifact path.
