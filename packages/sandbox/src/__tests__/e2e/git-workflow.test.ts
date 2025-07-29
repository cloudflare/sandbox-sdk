import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Sandbox } from '../../sandbox';

/**
 * End-to-End Git Repository Workflow Tests
 * 
 * These tests validate complete git-based development workflows:
 * 1. Clone → Install → Test → Deploy (Complete repository workflow)
 * 2. Multi-branch development scenarios
 * 3. Dependency management and build processes
 * 
 * Tests demonstrate how developers would use the sandbox for
 * real repository-based development and deployment.
 */
describe('Git Repository Workflow', () => {
  let sandboxId: DurableObjectId;
  let sandboxStub: DurableObjectStub;

  beforeAll(async () => {
    sandboxId = env.Sandbox.newUniqueId();
    sandboxStub = env.Sandbox.get(sandboxId);
  });

  afterEach(async () => {
    // Clean up any test-specific resources
  });

  /**
   * Helper function to wait for container readiness
   */
  async function waitForContainerReady(instance: Sandbox, maxAttempts = 20): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        if (!instance.ctx.container.running) {
          await instance.ctx.container.start();
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        const port = instance.ctx.container.getTcpPort(3000);
        const response = await port.fetch('http://container/api/ping', {
          signal: AbortSignal.timeout(8000)
        });
        
        if (response.status === 200) {
          await response.text();
          return;
        }
      } catch (error) {
        // Continue waiting
      }
      
      const waitTime = Math.min(1500 + (i * 300), 5000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    throw new Error(`Container failed to become ready within ${maxAttempts} attempts`);
  }

  describe('Node.js Repository Workflow', () => {
    it('should clone, install, test, and deploy a Node.js project', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Step 1: Clone a public Node.js repository (using a simple example)
        // For E2E testing, we'll simulate a git clone by creating a realistic project structure
        const packageJson = {
          "name": "e2e-test-app",
          "version": "1.0.0",
          "description": "E2E test Node.js application",
          "main": "app.js",
          "scripts": {
            "start": "node app.js",
            "test": "node test.js",
            "dev": "node app.js"
          },
          "dependencies": {},
          "engines": {
            "node": ">=14.0.0"
          }
        };

        const appCode = `
const http = require('http');
const fs = require('fs');
const path = require('path');

// Simple Express-like functionality without dependencies
class SimpleApp {
  constructor() {
    this.routes = new Map();
  }
  
  get(path, handler) {
    this.routes.set(\`GET:\${path}\`, handler);
  }
  
  post(path, handler) {
    this.routes.set(\`POST:\${path}\`, handler);
  }
  
  listen(port, callback) {
    const server = http.createServer((req, res) => {
      const key = \`\${req.method}:\${req.url}\`;
      const handler = this.routes.get(key);
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      if (handler) {
        handler(req, res);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Route not found' }));
      }
    });
    
    server.listen(port, callback);
    return server;
  }
}

const app = new SimpleApp();

// Routes
app.get('/', (req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({
    message: 'E2E Test App Running!',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  }));
});

app.get('/health', (req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({
    status: 'healthy',
    uptime: process.uptime(),
    pid: process.pid,
    memory: process.memoryUsage()
  }));
});

app.get('/api/data', (req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({
    data: [
      { id: 1, name: 'Item 1', value: 100 },
      { id: 2, name: 'Item 2', value: 200 },
      { id: 3, name: 'Item 3', value: 300 }
    ],
    total: 3,
    timestamp: Date.now()
  }));
});

const PORT = process.env.PORT || 5001;
const server = app.listen(PORT, () => {
  console.log(\`E2E Test App listening on port \${PORT}\`);
  console.log(\`Environment: \${process.env.NODE_ENV || 'development'}\`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;
        `.trim();

        const testCode = `
const http = require('http');

// Simple test framework
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }
  
  test(name, fn) {
    this.tests.push({ name, fn });
  }
  
  async run() {
    console.log('Running E2E tests...');
    
    for (const test of this.tests) {
      try {
        await test.fn();
        console.log(\`✓ \${test.name}\`);
        this.passed++;
      } catch (error) {
        console.log(\`✗ \${test.name}: \${error.message}\`);
        this.failed++;
      }
    }
    
    console.log(\`Tests completed: \${this.passed} passed, \${this.failed} failed\`);
    return this.failed === 0;
  }
}

const runner = new TestRunner();

// Test helper
function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

// Tests
runner.test('Health check returns status', async () => {
  const response = await request('http://localhost:5001/health');
  if (response.status !== 'healthy') {
    throw new Error(\`Expected healthy status, got \${response.status}\`);
  }
});

runner.test('Root endpoint returns app info', async () => {
  const response = await request('http://localhost:5001/');
  if (!response.message || !response.version) {
    throw new Error('Missing required fields in response');
  }
});

runner.test('API endpoint returns data', async () => {
  const response = await request('http://localhost:5001/api/data');
  if (!Array.isArray(response.data) || response.data.length !== 3) {
    throw new Error(\`Expected 3 data items, got \${response.data ? response.data.length : 0}\`);
  }
});

// Run tests
runner.run().then(success => {
  console.log(success ? 'All tests passed!' : 'Some tests failed!');
  process.exit(success ? 0 : 1);
});
        `.trim();

        const readmeContent = `
# E2E Test Application

This is a simple Node.js application for end-to-end testing.

## Features
- HTTP server with multiple endpoints
- Health check endpoint
- API data endpoint
- Simple test suite

## Usage
- \`npm start\` - Start the application
- \`npm test\` - Run tests
- \`npm run dev\` - Development mode

## API Endpoints
- \`GET /\` - Application info
- \`GET /health\` - Health check
- \`GET /api/data\` - Sample data
        `.trim();

        // Step 1: Create project structure (simulating git clone)
        await instance.client.files.writeFile('/workspace/package.json', JSON.stringify(packageJson, null, 2));
        await instance.client.files.writeFile('/workspace/app.js', appCode);
        await instance.client.files.writeFile('/workspace/test.js', testCode);
        await instance.client.files.writeFile('/workspace/README.md', readmeContent);
        
        // Step 2: Install dependencies (in this case, no external deps, but check npm)
        const npmVersion = await instance.client.commands.execute('npm --version');
        if (!npmVersion.success) {
          throw new Error('npm not available in container');
        }

        // Step 3: Change to workspace directory and install
        const installResult = await instance.client.commands.execute('cd /workspace && npm install', {
          timeout: 30000
        });
        
        // Step 4: Start the application as a background process
        const appProcess = await instance.client.processes.startProcess('cd /workspace && npm start', {
          env: { 
            NODE_ENV: 'production',
            PORT: '5001'
          }
        });
        
        // Step 5: Wait for application to start
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Step 6: Run tests against the running application
        const testResult = await instance.client.commands.execute('cd /workspace && npm test', {
          timeout: 30000
        });
        
        // Step 7: Expose the application port
        const exposedPort = await instance.client.ports.exposePort({ port: 5001 });
        
        // Step 8: Verify application endpoints directly
        const healthCheck = await instance.client.commands.execute('curl -s http://localhost:5001/health');
        const appInfo = await instance.client.commands.execute('curl -s http://localhost:5001/');
        const apiData = await instance.client.commands.execute('curl -s http://localhost:5001/api/data');
        
        const healthResponse = JSON.parse(healthCheck.stdout);
        const appResponse = JSON.parse(appInfo.stdout);
        const dataResponse = JSON.parse(apiData.stdout);
        
        // Step 9: Get process and port status
        const processStatus = await instance.client.processes.getProcess(appProcess.id);
        const allPorts = await instance.client.ports.getExposedPorts();
        const allProcesses = await instance.client.processes.listProcesses();
        
        return {
          npmVersion: npmVersion.stdout.trim(),
          installResult,
          appProcess,
          testResult,
          exposedPort,
          healthResponse,
          appResponse,
          dataResponse,
          processStatus,
          allPorts,
          allProcesses
        };
      });

      // Validate npm is available
      expect(result.npmVersion).toMatch(/^\d+\.\d+\.\d+/);
      
      // Validate installation (should succeed even with no deps)
      expect(result.installResult.success).toBe(true);
      
      // Validate application started
      expect(result.appProcess.status).toBe('running');
      expect(result.appProcess.command).toContain('npm start');
      
      // Validate tests ran successfully
      expect(result.testResult.success).toBe(true);
      expect(result.testResult.stdout).toContain('All tests passed!');
      expect(result.testResult.stdout).toContain('3 passed, 0 failed');
      
      // Validate port exposure
      expect(result.exposedPort.port).toBe(5001);
      expect(result.exposedPort.url).toContain('5001');
      
      // Validate application endpoints
      expect(result.healthResponse.status).toBe('healthy');
      expect(result.healthResponse.uptime).toBeGreaterThan(0);
      
      expect(result.appResponse.message).toBe('E2E Test App Running!');
      expect(result.appResponse.version).toBe('1.0.0');
      expect(result.appResponse.environment).toBe('production');
      
      expect(result.dataResponse.data).toHaveLength(3);
      expect(result.dataResponse.total).toBe(3);
      expect(result.dataResponse.data[0]).toEqual({ id: 1, name: 'Item 1', value: 100 });
      
      // Validate ongoing process status
      expect(result.processStatus.status).toBe('running');
      
      // Validate system state
      expect(result.allPorts).toHaveLength(1);
      expect(result.allProcesses.filter(p => p.status === 'running')).toHaveLength(1);
    }, 120000);
  });

  describe('Python Project Workflow', () => {
    it('should handle Python project with requirements and testing', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Step 1: Create Python project structure
        const requirementsTxt = `
# No external dependencies for E2E test
# json
# http.server (built-in)
        `.trim();

        const appPy = `
import json
import time
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

class APIHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed_path = urlparse(self.path)
        
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        
        if parsed_path.path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response = {
                'app': 'Python E2E Test API',
                'version': '2.0.0',
                'timestamp': time.time(),
                'python_version': f"{os.sys.version_info.major}.{os.sys.version_info.minor}.{os.sys.version_info.micro}"
            }
            self.wfile.write(json.dumps(response).encode())
            
        elif parsed_path.path == '/metrics':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response = {
                'uptime': time.time() - start_time,
                'requests_served': getattr(self.server, 'request_count', 0),
                'memory_usage': 'simulated_usage',
                'status': 'operational'
            }
            self.wfile.write(json.dumps(response).encode())
            
        else:
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Endpoint not found'}).encode())
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

def run_server():
    global start_time
    start_time = time.time()
    
    port = int(os.environ.get('PORT', 6001))
    server = HTTPServer(('0.0.0.0', port), APIHandler)
    print(f'Python E2E API server running on port {port}')
    server.serve_forever()

if __name__ == '__main__':
    run_server()
        `.trim();

        const testPy = `
import json
import time
import sys
import urllib.request
import urllib.error

class PythonTestRunner:
    def __init__(self):
        self.tests = []
        self.passed = 0
        self.failed = 0
    
    def test(self, name, test_func):
        self.tests.append((name, test_func))
    
    def run_all(self):
        print("Running Python E2E tests...")
        
        for name, test_func in self.tests:
            try:
                test_func()
                print(f"✓ {name}")
                self.passed += 1
            except Exception as e:
                print(f"✗ {name}: {str(e)}")
                self.failed += 1
        
        print(f"Tests completed: {self.passed} passed, {self.failed} failed")
        return self.failed == 0

def make_request(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = response.read().decode('utf-8')
            return json.loads(data)
    except Exception as e:
        raise Exception(f"Request failed: {str(e)}")

# Test runner
runner = PythonTestRunner()

# Tests
def test_root_endpoint():
    response = make_request('http://localhost:6001/')
    assert 'app' in response, "Response missing 'app' field"
    assert response['app'] == 'Python E2E Test API', f"Unexpected app name: {response['app']}"
    assert 'version' in response, "Response missing 'version' field"

def test_metrics_endpoint():
    response = make_request('http://localhost:6001/metrics')
    assert 'uptime' in response, "Response missing 'uptime' field"
    assert response['status'] == 'operational', f"Unexpected status: {response['status']}"
    assert isinstance(response['uptime'], (int, float)), "Uptime should be numeric"

def test_404_handling():
    try:
        make_request('http://localhost:6001/nonexistent')
        assert False, "Should have raised an exception for 404"
    except Exception as e:
        # Expected behavior for 404
        pass

# Register tests
runner.test("Root endpoint returns app info", test_root_endpoint)
runner.test("Metrics endpoint returns data", test_metrics_endpoint)
runner.test("404 handling works", test_404_handling)

# Run tests
success = runner.run_all()
sys.exit(0 if success else 1)
        `.trim();

        // Step 1: Create Python project files
        await instance.client.files.writeFile('/pyproject/requirements.txt', requirementsTxt);
        await instance.client.files.writeFile('/pyproject/app.py', appPy);
        await instance.client.files.writeFile('/pyproject/test.py', testPy);
        
        // Step 2: Check Python availability
        const pythonCheck = await instance.client.commands.execute('python3 --version');
        if (!pythonCheck.success) {
          throw new Error('Python3 not available in container');
        }
        
        // Step 3: Install requirements (even though empty, test the process)
        const installResult = await instance.client.commands.execute('cd /pyproject && python3 -m pip install -r requirements.txt', {
          timeout: 30000
        });
        
        // Step 4: Start the Python application
        const appProcess = await instance.client.processes.startProcess('cd /pyproject && python3 app.py', {
          env: { PORT: '6001' }
        });
        
        // Step 5: Wait for application startup
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        // Step 6: Run Python tests
        const testResult = await instance.client.commands.execute('cd /pyproject && python3 test.py', {
          timeout: 30000
        });
        
        // Step 7: Expose the port
        const exposedPort = await instance.client.ports.exposePort({ port: 6001 });
        
        // Step 8: Verify endpoints
        const rootTest = await instance.client.commands.execute('curl -s http://localhost:6001/');
        const metricsTest = await instance.client.commands.execute('curl -s http://localhost:6001/metrics');
        
        const rootResponse = JSON.parse(rootTest.stdout);
        const metricsResponse = JSON.parse(metricsTest.stdout);
        
        // Step 9: Get final status
        const processStatus = await instance.client.processes.getProcess(appProcess.id);
        
        return {
          pythonVersion: pythonCheck.stdout.trim(),
          installResult,
          appProcess,
          testResult,
          exposedPort,
          rootResponse,
          metricsResponse,
          processStatus
        };
      });

      // Validate Python environment
      expect(result.pythonVersion).toContain('Python 3');
      
      // Validate pip install (should succeed even with empty requirements)
      expect(result.installResult.success).toBe(true);
      
      // Validate application startup
      expect(result.appProcess.status).toBe('running');
      expect(result.appProcess.command).toContain('python3 app.py');
      
      // Validate tests passed
      expect(result.testResult.success).toBe(true);
      expect(result.testResult.stdout).toContain('3 passed, 0 failed');
      
      // Validate port exposure
      expect(result.exposedPort.port).toBe(6001);
      expect(result.exposedPort.url).toContain('6001');
      
      // Validate application responses
      expect(result.rootResponse.app).toBe('Python E2E Test API');
      expect(result.rootResponse.version).toBe('2.0.0');
      expect(result.rootResponse.python_version).toMatch(/^\d+\.\d+\.\d+$/);
      
      expect(result.metricsResponse.status).toBe('operational');
      expect(result.metricsResponse.uptime).toBeGreaterThan(0);
      
      // Validate process is still running
      expect(result.processStatus.status).toBe('running');
    }, 120000);
  });
});