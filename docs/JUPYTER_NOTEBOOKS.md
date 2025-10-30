# Running Jupyter Notebooks in Sandboxes

The Sandbox SDK provides lightweight code interpreters by default for optimal performance. However, you can easily add full Jupyter notebook support to your custom containers for advanced use cases like interactive data analysis, research environments, or educational platforms.

## Overview

This guide shows how to extend your sandbox container with Jupyter server to enable:

- Full Jupyter notebook interface at `http://your-preview-url:8888`
- Interactive Python and JavaScript kernels
- Rich visualizations and data analysis tools
- Traditional notebook file (.ipynb) management

## Container Setup

Create a custom Dockerfile that extends the base sandbox image:

```dockerfile
FROM docker.io/cloudflare/sandbox:latest

# Install Jupyter components
RUN pip3 install --no-cache-dir \
    jupyter-server \
    jupyter-client \
    ipykernel \
    orjson \
    && python3 -m ipykernel install --user --name python3

# Install scientific packages for data analysis
RUN pip3 install --no-cache-dir \
    matplotlib \
    numpy \
    pandas \
    seaborn \
    plotly \
    scipy \
    scikit-learn

# Install JavaScript kernel (optional)
RUN npm install -g ijavascript \
    && ijsinstall --install=global

# Copy Jupyter configuration
COPY jupyter_config.py /root/.jupyter/

# Expose Jupyter port
EXPOSE 8888

# Start both sandbox service and Jupyter
COPY start-jupyter.sh /
RUN chmod +x /start-jupyter.sh
CMD ["/start-jupyter.sh"]
```

## Configuration Files

**jupyter_config.py** - Minimal Jupyter configuration:

```python
"""Jupyter configuration for sandbox environment"""

c = get_config()

# Disable authentication (container handles security)
c.ServerApp.token = ''
c.ServerApp.password = ''
c.ServerApp.allow_origin = '*'
c.ServerApp.allow_remote_access = True
c.ServerApp.disable_check_xsrf = True
c.ServerApp.allow_root = True

# Network settings
c.ServerApp.ip = '0.0.0.0'
c.ServerApp.port = 8888
c.ServerApp.open_browser = False

# Performance optimizations
c.ServerApp.iopub_data_rate_limit = 1000000000
c.Application.log_level = 'WARN'
c.KernelManager.shutdown_wait_time = 1.0

# Disable terminals and unnecessary extensions
c.ServerApp.terminals_enabled = False
c.ServerApp.jpserver_extensions = {}
```

**start-jupyter.sh** - Startup script:

```bash
#!/bin/bash

# Start Jupyter in background
jupyter server --config=/root/.jupyter/jupyter_config.py &

# Start the main sandbox service
exec /container-server/startup.sh
```

## Usage

Once deployed, access Jupyter through your sandbox:

```typescript
import { getSandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request, env) {
    const sandbox = getSandbox(env.Sandbox, 'jupyter-env');

    // Expose Jupyter port
    const preview = await sandbox.exposePort(8888, { name: 'jupyter' });

    return new Response(`Jupyter available at: ${preview.url}`);
  }
};
```

## Example: Setting Up Jupyter Environment

```typescript
// Create sample data files for analysis
await sandbox.writeFile(
  '/workspace/sample_data.csv',
  `
date,sales,marketing_spend
2024-01-01,1200,450
2024-01-02,980,520
2024-01-03,1100,480
2024-01-04,1350,600
2024-01-05,1050,400
`
);

// Create a starter notebook
await sandbox.writeFile(
  '/workspace/analysis.ipynb',
  JSON.stringify({
    cells: [
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          'import pandas as pd\nimport matplotlib.pyplot as plt\n\n# Load the sample data\ndf = pd.read_csv(\'sample_data.csv\')\nprint("Data loaded successfully!")\ndf.head()'
        ]
      }
    ],
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3'
      }
    },
    nbformat: 4,
    nbformat_minor: 4
  })
);

// Expose Jupyter interface
const preview = await sandbox.exposePort(8888);
console.log(`Jupyter notebook interface: ${preview.url}`);
console.log(`Open analysis.ipynb to start analyzing the sample data`);
```
