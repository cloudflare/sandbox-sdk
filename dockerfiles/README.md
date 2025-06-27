# Sandbox Docker Environments

This directory contains multiple Docker environment configurations for different use cases.

## Available Environments

### Default Environment
- **File**: `../packages/sandbox/Dockerfile`
- **Size**: ~200MB
- **Languages**: JavaScript, TypeScript
- **Use Cases**: Basic JS/TS execution, lightweight applications

### Python Data Science
- **File**: `python-data-science.dockerfile`
- **Size**: ~2.5GB
- **Languages**: Python, JavaScript, TypeScript
- **Packages**: numpy, pandas, matplotlib, scikit-learn, torch, transformers, jupyter
- **Use Cases**: 
  - Data analysis and visualization
  - Machine learning model training
  - Jupyter notebook execution
  - AI/ML prototyping

### Node Extended
- **File**: `node-extended.dockerfile`
- **Size**: ~1.2GB
- **Languages**: JavaScript, TypeScript, Python
- **Packages**: express, fastify, mongoose, prisma, webpack, jest, cypress
- **Use Cases**:
  - Full-stack web development
  - API development
  - Testing and CI/CD
  - Build tool workflows

### Multi-Language
- **File**: `multi-lang.dockerfile`
- **Size**: ~4GB
- **Languages**: Python, JavaScript, TypeScript, Go, Java, Rust, Ruby, R
- **Use Cases**:
  - Cross-language development
  - Polyglot applications
  - Language comparison and testing
  - Educational environments

## How to Use

### Environment Variable
```bash
export SANDBOX_ENVIRONMENT=python-data-science
docker build -f dockerfiles/python-data-science.dockerfile .
```

### Configuration File
Create `.sandbox-config.json` in your project root:
```json
{
  "environment": "node-extended"
}
```

### CLI Flag (if supported by your tooling)
```bash
sandbox-cli --environment multi-lang
```

## Building Images

### Python Data Science
```bash
docker build -f dockerfiles/python-data-science.dockerfile -t sandbox-python-ds .
docker run -p 3000:3000 sandbox-python-ds
```

### Node Extended
```bash
docker build -f dockerfiles/node-extended.dockerfile -t sandbox-node-ext .
docker run -p 3000:3000 sandbox-node-ext
```

### Multi-Language
```bash
docker build -f dockerfiles/multi-lang.dockerfile -t sandbox-multi-lang .
docker run -p 3000:3000 sandbox-multi-lang
```

## Performance Considerations

| Environment | Build Time | Image Size | Memory Usage |
|-------------|------------|------------|--------------|
| Default | ~2 min | ~200MB | ~50MB |
| Python Data Science | ~8 min | ~2.5GB | ~300MB |
| Node Extended | ~5 min | ~1.2GB | ~150MB |
| Multi-Language | ~12 min | ~4GB | ~500MB |

## Choosing the Right Environment

- **Default**: For simple JavaScript/TypeScript tasks
- **Python Data Science**: For ML, data analysis, or scientific computing
- **Node Extended**: For web development with comprehensive tooling
- **Multi-Language**: For polyglot development or when language requirements are unknown

## Customization

You can extend any of these environments by:

1. Creating a new dockerfile that uses one as a base:
```dockerfile
FROM sandbox-python-ds
RUN pip install your-custom-package
```

2. Modifying the existing dockerfiles to add specific packages
3. Creating environment-specific configuration files