# Execute Arbitrary Code

The Cloudflare Sandbox SDK allows you to run any code or command within secure, isolated containers on Cloudflare's edge network. This guide demonstrates various patterns for executing code safely and efficiently.

## Quick Start

```typescript
import { getSandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env) {
    const sandbox = getSandbox(env.Sandbox, "my-executor");
    
    // Execute any command
    const result = await sandbox.exec("echo 'Hello from the edge!'");
    
    return new Response(result.stdout);
  },
};
```

## Basic Code Execution

### Running Shell Commands

```typescript
const sandbox = getSandbox(env.Sandbox, "shell-runner");

// System commands
await sandbox.exec("ls -la /workspace");
await sandbox.exec("ps aux");
await sandbox.exec("df -h");

// Package management
await sandbox.exec("apt-get update");
await sandbox.exec("apt-get install -y curl");
```

### Multi-Language Support

The sandbox supports any language available in the container image:

```typescript
// Python
await sandbox.exec("python3 -c 'print(\"Hello from Python!\")'");

// Node.js
await sandbox.exec("node -e 'console.log(\"Hello from Node!\")'");

// Go
await sandbox.writeFile("/tmp/hello.go", `
package main
import "fmt"
func main() {
    fmt.Println("Hello from Go!")
}
`);
await sandbox.exec("cd /tmp && go run hello.go");

// Rust
await sandbox.writeFile("/tmp/hello.rs", `
fn main() {
    println!("Hello from Rust!");
}
`);
await sandbox.exec("cd /tmp && rustc hello.rs && ./hello");
```

## File-Based Code Execution

### Creating and Running Scripts

```typescript
const sandbox = getSandbox(env.Sandbox, "script-runner");

// Create a complex script
await sandbox.writeFile("/workspace/data_processor.py", `
import json
import sys
from datetime import datetime

def process_data(input_data):
    result = {
        'processed_at': datetime.now().isoformat(),
        'input_count': len(input_data),
        'processed_items': []
    }
    
    for item in input_data:
        processed_item = {
            'original': item,
            'uppercase': item.upper(),
            'length': len(item)
        }
        result['processed_items'].append(processed_item)
    
    return result

if __name__ == "__main__":
    input_data = json.loads(sys.argv[1])
    result = process_data(input_data)
    print(json.dumps(result, indent=2))
`);

// Execute with arguments
const input = JSON.stringify(["hello", "world", "from", "cloudflare"]);
const result = await sandbox.exec(`python3 /workspace/data_processor.py '${input}'`);
const processedData = JSON.parse(result.stdout);

console.log("Processed data:", processedData);
```

### Working with Git Repositories

```typescript
const sandbox = getSandbox(env.Sandbox, "git-executor");

// Clone and execute code from repository
await sandbox.gitCheckout("https://github.com/user/my-project", {
  branch: "main",
  targetDir: "/workspace/project"
});

// Install dependencies and run
await sandbox.exec("cd /workspace/project && npm install");
await sandbox.exec("cd /workspace/project && npm run build");
await sandbox.exec("cd /workspace/project && npm test");
```

## Environment Management

### Setting Up Execution Context

```typescript
const sandbox = getSandbox(env.Sandbox, "env-aware");

// Set environment variables
await sandbox.setEnvVars({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://localhost:5432/mydb",
  API_KEY: "secret-api-key",
  CUSTOM_CONFIG: JSON.stringify({ feature: "enabled" })
});

// Commands now have access to these variables
const result = await sandbox.exec("echo $NODE_ENV");
console.log(result.stdout); // "production"
```

### Working Directory Management

```typescript
// Create organized directory structure
await sandbox.mkdir("/workspace/src", { recursive: true });
await sandbox.mkdir("/workspace/tests", { recursive: true });
await sandbox.mkdir("/workspace/build", { recursive: true });

// Execute in specific directories
await sandbox.exec("pwd", { cwd: "/workspace/src" });
await sandbox.exec("ls -la", { cwd: "/workspace/tests" });
```

## Advanced Execution Patterns

### Streaming Long-Running Commands

```typescript
import { parseSSEStream, type ExecEvent } from "@cloudflare/sandbox";

const sandbox = getSandbox(env.Sandbox, "stream-processor");

// Stream output in real-time
const stream = await sandbox.execStream("npm run build:large-project");

for await (const event of parseSSEStream<ExecEvent>(stream)) {
  switch (event.type) {
    case 'start':
      console.log(`Started: ${event.command}`);
      break;
    case 'stdout':
      console.log(`Output: ${event.data}`);
      break;
    case 'stderr':
      console.error(`Error: ${event.data}`);
      break;
    case 'complete':
      console.log(`Completed with exit code: ${event.exitCode}`);
      break;
  }
}
```

### Background Process Management

```typescript
const sandbox = getSandbox(env.Sandbox, "process-manager");

// Start background services
const webServer = await sandbox.startProcess("python3 -m http.server 8080", {
  processId: "web-server",
  cwd: "/workspace/static"
});

const worker = await sandbox.startProcess("python3 worker.py", {
  processId: "background-worker",
  env: { WORKER_ID: "1" }
});

// Monitor processes
const processes = await sandbox.listProcesses();
console.log("Running processes:", processes.map(p => p.id));

// Clean up when done
await sandbox.killProcess("web-server");
await sandbox.killProcess("background-worker");
```

## Code Interpreter Integration

### Python Data Science

```typescript
const sandbox = getSandbox(env.Sandbox, "data-science");

// Create Python context for persistent execution
const pythonCtx = await sandbox.createCodeContext({ language: 'python' });

// Execute complex data analysis
const analysis = await sandbox.runCode(`
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

# Generate sample data
np.random.seed(42)
data = {
    'date': pd.date_range('2024-01-01', periods=100),
    'sales': np.random.normal(1000, 200, 100),
    'profit': np.random.normal(150, 50, 100)
}
df = pd.DataFrame(data)

# Analysis
summary = df.describe()
correlation = df[['sales', 'profit']].corr()

# Visualization
plt.figure(figsize=(12, 4))
plt.subplot(1, 2, 1)
plt.plot(df['date'], df['sales'])
plt.title('Sales Over Time')
plt.xticks(rotation=45)

plt.subplot(1, 2, 2)
plt.scatter(df['sales'], df['profit'])
plt.title('Sales vs Profit')
plt.xlabel('Sales')
plt.ylabel('Profit')

plt.tight_layout()
plt.show()

# Return results
{
    'summary': summary.to_dict(),
    'correlation': correlation.to_dict(),
    'total_sales': df['sales'].sum(),
    'avg_profit': df['profit'].mean()
}
`, { 
  context: pythonCtx,
  onResult: (result) => {
    if (result.png) {
      console.log('Chart generated:', result.png.substring(0, 50) + '...');
    }
    if (result.json) {
      console.log('Analysis results:', result.json);
    }
  }
});
```

### JavaScript/TypeScript Execution

```typescript
const jsCtx = await sandbox.createCodeContext({ language: 'javascript' });

const result = await sandbox.runCode(`
const fs = require('fs');
const path = require('path');

// Process configuration files
function processConfig(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Transform config
    const processed = {
      ...config,
      processed_at: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      features: Object.keys(config.features || {}).filter(
        key => config.features[key] === true
      )
    };
    
    return processed;
  } catch (error) {
    return { error: error.message };
  }
}

// Example usage
const testConfig = {
  name: "My App",
  version: "1.0.0",
  features: {
    auth: true,
    analytics: false,
    beta: true
  }
};

// Write test config
fs.writeFileSync('/tmp/config.json', JSON.stringify(testConfig, null, 2));

// Process it
const result = processConfig('/tmp/config.json');
console.log('Processed config:', JSON.stringify(result, null, 2));

result;
`, { context: jsCtx });
```

## Security Considerations

### Input Sanitization

```typescript
function sanitizeCommand(userInput: string): string {
  // Remove dangerous characters and commands
  const dangerous = [';', '|', '&', '$', '`', '(', ')', '<', '>', '\\n', '\\r'];
  let sanitized = userInput;
  
  for (const char of dangerous) {
    sanitized = sanitized.replace(new RegExp(char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
  }
  
  return sanitized.trim();
}

// Safe command execution
const userCommand = sanitizeCommand(request.url.searchParams.get('cmd') || '');
if (userCommand) {
  const result = await sandbox.exec(`echo "${userCommand}"`);
  return new Response(result.stdout);
}
```

### Resource Limits and Timeouts

```typescript
// Set execution timeouts
const result = await sandbox.exec("long-running-process", {
  timeout: 60000, // 60 seconds
  onOutput: (stream, data) => {
    console.log(`[${stream}] ${data}`);
  }
});

// Monitor resource usage
const processes = await sandbox.listProcesses();
const activeProcesses = processes.filter(p => p.status === 'running');

if (activeProcesses.length > 10) {
  console.warn('High process count detected');
  await sandbox.killAllProcesses();
}
```

