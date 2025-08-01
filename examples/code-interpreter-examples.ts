import { getSandbox } from '@cloudflare/sandbox';
import type { Sandbox, CodeContext, Result } from '@cloudflare/sandbox';

// Basic Python execution
async function basicPythonExample(env: any) {
  const sandbox = getSandbox(env.Sandbox, "python-demo");
  
  // Create a Python context
  const pythonCtx = await sandbox.createCodeContext({ language: 'python' });
  
  // Execute simple code
  const execution = await sandbox.runCode('print("Hello from Python!")', { 
    context: pythonCtx 
  });
  
  console.log('Output:', execution.logs.stdout.join(''));
  console.log('Errors:', execution.error);
}

// Data analysis with pandas
async function dataAnalysisExample(env: any) {
  const sandbox = getSandbox(env.Sandbox, "data-analysis");
  const ctx = await sandbox.createCodeContext({ language: 'python' });
  
  // Import libraries
  await sandbox.runCode('import pandas as pd\nimport numpy as np', { context: ctx });
  
  // Create and analyze data
  const execution = await sandbox.runCode(`
df = pd.DataFrame({
    'name': ['Alice', 'Bob', 'Charlie', 'David'],
    'age': [25, 30, 35, 28],
    'score': [92, 88, 95, 90]
})

print(df.describe())
df.head()
  `, { 
    context: ctx,
    onResult: (result) => {
      if (result.html) {
        console.log('DataFrame HTML:', result.html);
      }
    }
  });
  
  // Results will include both stdout (from print) and rich HTML table
  console.log('Statistics:', execution.logs.stdout.join('\n'));
  console.log('Table formats:', execution.results[0]?.formats());
}

// Visualization example
async function chartExample(env: any) {
  const sandbox = getSandbox(env.Sandbox, "charts");
  const ctx = await sandbox.createCodeContext({ language: 'python' });
  
  const execution = await sandbox.runCode(`
import matplotlib.pyplot as plt
import numpy as np

# Create data
x = np.linspace(0, 10, 100)
y = np.sin(x)

# Create plot
plt.figure(figsize=(8, 6))
plt.plot(x, y, 'b-', linewidth=2)
plt.title('Sine Wave')
plt.xlabel('X')
plt.ylabel('Y')
plt.grid(True)
plt.show()
  `, { 
    context: ctx,
    onResult: (result) => {
      if (result.png) {
        console.log('Chart generated! Base64 length:', result.png.length);
        // In a real app, you could display this as an image:
        // <img src={`data:image/png;base64,${result.png}`} />
      }
    }
  });
  
  const chartResult = execution.results[0];
  if (chartResult?.chart) {
    console.log('Chart type:', chartResult.chart.type);
    console.log('Chart library:', chartResult.chart.library);
  }
}

// JavaScript execution
async function javascriptExample(env: any) {
  const sandbox = getSandbox(env.Sandbox, "js-demo");
  const jsCtx = await sandbox.createCodeContext({ language: 'javascript' });
  
  const execution = await sandbox.runCode(`
const data = [1, 2, 3, 4, 5];
const sum = data.reduce((a, b) => a + b, 0);
console.log('Sum:', sum);
console.log('Average:', sum / data.length);

// Return object for inspection
{ sum, average: sum / data.length }
  `, { context: jsCtx });
  
  console.log('JS Output:', execution.logs.stdout.join('\n'));
  if (execution.results[0]?.json) {
    console.log('Result data:', execution.results[0].json);
  }
}

// Streaming execution with progress
async function streamingExample(env: any) {
  const sandbox = getSandbox(env.Sandbox, "streaming");
  const ctx = await sandbox.createCodeContext({ language: 'python' });
  
  console.log('Starting long-running computation...');
  
  await sandbox.runCode(`
import time

for i in range(5):
    print(f"Processing step {i+1}/5...")
    # Simulate work
    time.sleep(0.5)
    result = i ** 2
    print(f"  Result: {result}")

print("\\nComputation complete!")
  `, { 
    context: ctx,
    onStdout: (output) => {
      // Real-time output as it happens
      process.stdout.write(output.text);
    }
  });
}

// Multi-language workflow
async function multiLanguageWorkflow(env: any) {
  const sandbox = getSandbox(env.Sandbox, "multi-lang");
  
  // Step 1: Process data in Python
  const pythonCtx = await sandbox.createCodeContext({ language: 'python' });
  await sandbox.runCode(`
import json

# Process some data
data = {
    "users": ["Alice", "Bob", "Charlie"],
    "scores": [92, 88, 95],
    "average": sum([92, 88, 95]) / 3
}

# Save to file
with open("/tmp/results.json", "w") as f:
    json.dump(data, f)

print("Data processed and saved!")
  `, { context: pythonCtx });
  
  // Step 2: Read and process in JavaScript
  const jsCtx = await sandbox.createCodeContext({ language: 'javascript' });
  const jsExecution = await sandbox.runCode(`
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/results.json', 'utf8'));

console.log('Users:', data.users.join(', '));
console.log('Average score:', data.average);

// Transform data
const report = {
  timestamp: new Date().toISOString(),
  summary: \`Processed \${data.users.length} users\`,
  highScore: Math.max(...data.scores)
};

console.log('Report:', JSON.stringify(report, null, 2));
report;
  `, { context: jsCtx });
  
  console.log('JavaScript output:', jsExecution.logs.stdout.join('\n'));
}

// Error handling example
async function errorHandlingExample(env: any) {
  const sandbox = getSandbox(env.Sandbox, "error-demo");
  const ctx = await sandbox.createCodeContext({ language: 'python' });
  
  const execution = await sandbox.runCode(`
# This will cause an error
x = 10
y = 0
result = x / y
  `, { 
    context: ctx,
    onError: (error) => {
      console.log('Error caught!');
      console.log('Type:', error.name);
      console.log('Message:', error.value);
      console.log('Traceback:', error.traceback.join('\n'));
    }
  });
  
  if (execution.error) {
    console.log('Execution failed with:', execution.error.name);
  }
}

// Context management
async function contextManagementExample(env: any) {
  const sandbox = getSandbox(env.Sandbox, "context-demo");
  
  // Create multiple contexts
  const contexts = await Promise.all([
    sandbox.createCodeContext({ language: 'python', cwd: '/tmp' }),
    sandbox.createCodeContext({ language: 'javascript' }),
    sandbox.createCodeContext({ 
      language: 'python', 
      envVars: { 'MY_VAR': 'hello' } 
    })
  ]);
  
  console.log('Created', contexts.length, 'contexts');
  
  // List all contexts
  const allContexts = await sandbox.listCodeContexts();
  console.log('Total contexts:', allContexts.length);
  
  // Use context with environment variable
  const envContext = contexts[2];
  await sandbox.runCode(`
import os
print(f"MY_VAR = {os.environ.get('MY_VAR', 'not set')}")
  `, { context: envContext });
  
  // Clean up
  for (const ctx of contexts) {
    await sandbox.deleteCodeContext(ctx.id);
  }
  console.log('Cleaned up contexts');
}

// Main export for the Worker
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    
    switch (url.pathname) {
      case '/basic':
        await basicPythonExample(env);
        return new Response('Basic example complete');
        
      case '/data':
        await dataAnalysisExample(env);
        return new Response('Data analysis example complete');
        
      case '/chart':
        await chartExample(env);
        return new Response('Chart example complete');
        
      case '/javascript':
        await javascriptExample(env);
        return new Response('JavaScript example complete');
        
      case '/streaming':
        await streamingExample(env);
        return new Response('Streaming example complete');
        
      case '/multi':
        await multiLanguageWorkflow(env);
        return new Response('Multi-language example complete');
        
      case '/error':
        await errorHandlingExample(env);
        return new Response('Error handling example complete');
        
      case '/contexts':
        await contextManagementExample(env);
        return new Response('Context management example complete');
        
      default:
        return new Response(`
Available examples:
- /basic - Basic Python execution
- /data - Data analysis with pandas
- /chart - Matplotlib visualization
- /javascript - JavaScript execution
- /streaming - Real-time output streaming
- /multi - Multi-language workflow
- /error - Error handling
- /contexts - Context management
        `, { headers: { 'Content-Type': 'text/plain' } });
    }
  }
};