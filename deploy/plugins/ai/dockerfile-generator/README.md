# dockerfile-generator

AI-powered Dockerfile generator that analyzes project source code and produces an optimized, production-ready Dockerfile using a local Ollama model

**Version:** 1.0.0  
**Category:** ai  
**Plugin Type:** CodeBuildStep  
**Compute:** LARGE  
**Timeout:** 30 minutes  
**Failure Behavior:** fail  

## Keywords

`dockerfile`, `ai`, `ollama`, `generator`, `docker`, `codegen`

## Requirements

- Node.js
- Python
- Java
- C++ build tools (gcc, cmake, make)

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_MODEL` | `codellama:7b` | Ollama AI model to use |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama service endpoint |
| `OLLAMA_NUM_CTX` | `8192` | Ollama context window size |

## Output

Primary output directory: `generated`

## Usage

This plugin runs as an AWS CDK `CodeBuildStep` within the Pipeline Builder platform. Add it as a step in your pipeline configuration:

```json
{
  "name": "dockerfile-generator",
  "plugin": "dockerfile-generator",
  "env": {
    "OLLAMA_MODEL": "codellama:7b",
    "OLLAMA_HOST": "http://localhost:11434",
    "OLLAMA_NUM_CTX": "8192"
  }
}
```

## Files

| File | Description |
|------|-------------|
| `manifest.yaml` | Plugin configuration and build commands |
| `Dockerfile` | Container image definition |
| `plugin.zip` | Packaged plugin archive |
| `README.md` | This documentation file |
