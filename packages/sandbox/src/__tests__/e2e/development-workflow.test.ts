import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Sandbox } from '../../sandbox';

/**
 * End-to-End Development Workflow Tests
 * 
 * These tests validate complete user workflows from start to finish:
 * 1. Write → Execute → Expose → Access (Complete development cycle)
 * 2. Multi-step project setup and deployment
 * 3. Real-world development scenarios
 * 
 * Tests use the container-enabled sandbox with dynamic build IDs
 * and validate the entire client→container→service flow.
 */
describe('Complete Development Workflow', () => {
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
   * Reused from container tests with enhanced timeout for E2E
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

  describe('Complete Node.js Application Workflow', () => {
    it('should execute complete write → execute → expose → access workflow', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Step 1: Write a simple Node.js HTTP server
        const appCode = `
const http = require('http');
const url = require('url');

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  
  // CORS headers for testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (parsedUrl.pathname === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ 
      message: 'Hello from E2E test server!',
      timestamp: new Date().toISOString(),
      path: parsedUrl.pathname
    }));
  } else if (parsedUrl.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ 
      status: 'healthy', 
      uptime: process.uptime(),
      pid: process.pid
    }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(\`Server running on port \${PORT}\`);
});
        `.trim();

        await instance.client.files.writeFile('/app/server.js', appCode);
        
        // Step 2: Execute the application as a background process
        const process = await instance.client.processes.startProcess('node /app/server.js', {
          env: { PORT: '3001' }
        });
        
        // Step 3: Wait for server to start up
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Step 4: Expose the port for external access
        const exposedPort = await instance.client.ports.exposePort({ port: 3001 });
        
        // Step 5: Verify the application is accessible
        // Test root endpoint
        const rootCmd = await instance.client.commands.execute('curl -s http://localhost:3001/');
        const rootResponse = JSON.parse(rootCmd.stdout);
        
        // Test health endpoint
        const healthCmd = await instance.client.commands.execute('curl -s http://localhost:3001/health');
        const healthResponse = JSON.parse(healthCmd.stdout);
        
        // Step 6: Verify process is still running
        const processStatus = await instance.client.processes.getProcess(process.id);
        
        // Step 7: Get list of exposed ports
        const exposedPorts = await instance.client.ports.getExposedPorts();
        
        return {
          appWritten: true,
          process,
          exposedPort,
          rootResponse,
          healthResponse,
          processStatus,
          exposedPorts
        };
      });

      // Validate the complete workflow
      expect(result.appWritten).toBe(true);
      
      // Validate process was started successfully
      expect(result.process.id).toBeDefined();
      expect(result.process.command).toBe('node /app/server.js');
      expect(result.process.status).toBe('running');
      
      // Validate port was exposed
      expect(result.exposedPort.port).toBe(3001);
      expect(result.exposedPort.url).toBeDefined();
      expect(result.exposedPort.url).toContain('3001');
      
      // Validate application responses
      expect(result.rootResponse.message).toBe('Hello from E2E test server!');
      expect(result.rootResponse.timestamp).toBeDefined();
      expect(result.rootResponse.path).toBe('/');
      
      expect(result.healthResponse.status).toBe('healthy');
      expect(result.healthResponse.uptime).toBeGreaterThan(0);
      expect(result.healthResponse.pid).toBeDefined();
      
      // Validate process is still running
      expect(result.processStatus.status).toBe('running');
      expect(result.processStatus.pid).toBeDefined();
      
      // Validate port is in exposed ports list
      expect(result.exposedPorts.length).toBe(1);
      expect(result.exposedPorts[0].port).toBe(3001);
    }, 120000); // 2 minute timeout for complete workflow
  });

  describe('Python Flask Application Workflow', () => {
    it('should execute complete Python web app development workflow', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Step 1: Check if Python is available
        const pythonCheck = await instance.client.commands.execute('python3 --version');
        if (!pythonCheck.success) {
          throw new Error('Python not available in container');
        }
        
        // Step 2: Write a simple Flask application
        const flaskApp = `
import json
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

class FlaskLikeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed_path = urlparse(self.path)
        
        # CORS headers
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        
        if parsed_path.path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response = {
                'message': 'Hello from Python E2E test!',
                'framework': 'Pure Python HTTP Server',
                'timestamp': time.time(),
                'path': parsed_path.path
            }
            self.wfile.write(json.dumps(response).encode())
            
        elif parsed_path.path == '/api/status':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response = {
                'status': 'running',
                'uptime': time.time() - start_time,
                'version': 'python-e2e-1.0'
            }
            self.wfile.write(json.dumps(response).encode())
            
        else:
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Not found'}).encode())
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

if __name__ == '__main__':
    start_time = time.time()
    port = int(os.environ.get('PORT', 3002))
    server = HTTPServer(('0.0.0.0', port), FlaskLikeHandler)
    print(f'Python server running on port {port}')
    server.serve_forever()
        `.trim();

        await instance.client.files.writeFile('/app/flask_app.py', flaskApp);
        
        // Step 3: Start the Python application
        const process = await instance.client.processes.startProcess('python3 /app/flask_app.py', {
          env: { PORT: '3002' }
        });
        
        // Step 4: Wait for server startup
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Step 5: Expose the port
        const exposedPort = await instance.client.ports.exposePort({ port: 3002 });
        
        // Step 6: Test the application endpoints
        const rootTest = await instance.client.commands.execute('curl -s http://localhost:3002/');
        const statusTest = await instance.client.commands.execute('curl -s http://localhost:3002/api/status');
        
        let rootResponse, statusResponse;
        try {
          rootResponse = JSON.parse(rootTest.stdout);
          statusResponse = JSON.parse(statusTest.stdout);
        } catch (error) {
          // Handle potential JSON parsing errors
          throw new Error(`Failed to parse responses: ${error}. Root: ${rootTest.stdout}, Status: ${statusTest.stdout}`);
        }
        
        // Step 7: Verify process status
        const processInfo = await instance.client.processes.getProcess(process.id);
        
        return {
          pythonVersion: pythonCheck.stdout.trim(),
          process,
          exposedPort,
          rootResponse,
          statusResponse,
          processInfo
        };
      });

      // Validate Python workflow
      expect(result.pythonVersion).toContain('Python 3');
      
      // Validate process startup
      expect(result.process.status).toBe('running');
      expect(result.process.command).toBe('python3 /app/flask_app.py');
      
      // Validate port exposure
      expect(result.exposedPort.port).toBe(3002);
      expect(result.exposedPort.url).toContain('3002');
      
      // Validate application responses
      expect(result.rootResponse.message).toBe('Hello from Python E2E test!');
      expect(result.rootResponse.framework).toBe('Pure Python HTTP Server');
      expect(result.rootResponse.timestamp).toBeTypeOf('number');
      
      expect(result.statusResponse.status).toBe('running');
      expect(result.statusResponse.uptime).toBeGreaterThan(0);
      expect(result.statusResponse.version).toBe('python-e2e-1.0');
      
      // Validate ongoing process status
      expect(result.processInfo.status).toBe('running');
    }, 120000);
  });

  describe('Multi-Service Workflow', () => {
    it('should handle multiple services running simultaneously', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Service 1: Simple JSON API (Node.js)
        const apiCode = `
const http = require('http');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.url === '/api/data') {
    res.writeHead(200);
    res.end(JSON.stringify({ 
      service: 'api',
      data: [1, 2, 3, 4, 5],
      timestamp: Date.now()
    }));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'API endpoint not found' }));
  }
});
server.listen(4001, () => console.log('API service on 4001'));
        `.trim();

        // Service 2: Static file server (Python)
        const staticCode = `
import http.server
import socketserver
import json
import os

PORT = 4002

class StaticHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/static/info':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            response = {
                'service': 'static',
                'files': ['index.html', 'style.css', 'app.js'],
                'port': PORT
            }
            self.wfile.write(json.dumps(response).encode())
        else:
            super().do_GET()

with socketserver.TCPServer(("", PORT), StaticHandler) as httpd:
    print(f"Static server on {PORT}")
    httpd.serve_forever()
        `.trim();

        // Step 1: Write both services
        await instance.client.files.writeFile('/app/api-service.js', apiCode);
        await instance.client.files.writeFile('/app/static-service.py', staticCode);
        
        // Step 2: Start both services as background processes
        const apiProcess = await instance.client.processes.startProcess('node /app/api-service.js');
        const staticProcess = await instance.client.processes.startProcess('python3 /app/static-service.py');
        
        // Step 3: Wait for both services to start
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        // Step 4: Expose both ports
        const apiPort = await instance.client.ports.exposePort({ port: 4001 });
        const staticPort = await instance.client.ports.exposePort({ port: 4002 });
        
        // Step 5: Test both services
        const apiTest = await instance.client.commands.execute('curl -s http://localhost:4001/api/data');
        const staticTest = await instance.client.commands.execute('curl -s http://localhost:4002/static/info');
        
        const apiResponse = JSON.parse(apiTest.stdout);
        const staticResponse = JSON.parse(staticTest.stdout);
        
        // Step 6: Verify all processes are running
        const processes = await instance.client.processes.listProcesses();
        const exposedPorts = await instance.client.ports.getExposedPorts();
        
        return {
          apiProcess,
          staticProcess,
          apiPort,
          staticPort,
          apiResponse,
          staticResponse,
          processes,
          exposedPorts
        };
      });

      // Validate both services started
      expect(result.apiProcess.status).toBe('running');
      expect(result.staticProcess.status).toBe('running');
      
      // Validate both ports exposed
      expect(result.apiPort.port).toBe(4001);
      expect(result.staticPort.port).toBe(4002);
      
      // Validate service responses
      expect(result.apiResponse.service).toBe('api');
      expect(result.apiResponse.data).toEqual([1, 2, 3, 4, 5]);
      expect(result.apiResponse.timestamp).toBeTypeOf('number');
      
      expect(result.staticResponse.service).toBe('static');
      expect(result.staticResponse.files).toContain('index.html');
      expect(result.staticResponse.port).toBe(4002);
      
      // Validate process management
      expect(result.processes.length).toBeGreaterThanOrEqual(2);
      const runningProcesses = result.processes.filter(p => p.status === 'running');
      expect(runningProcesses.length).toBeGreaterThanOrEqual(2);
      
      // Validate port management
      expect(result.exposedPorts.length).toBe(2);
      const portNumbers = result.exposedPorts.map(p => p.port).sort();
      expect(portNumbers).toEqual([4001, 4002]);
    }, 120000);
  });
});