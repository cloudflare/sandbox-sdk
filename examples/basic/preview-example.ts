/**
 * Example demonstrating the Preview URLs & Port Management feature
 */

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

async function demonstratePreviewUrls(env: Env) {
  // Get a sandbox instance
  const sandbox = getSandbox(env.Sandbox, "preview-demo");

  // Example 1: Start a Python HTTP server and expose it
  console.log("Starting Python HTTP server...");
  await sandbox.exec("python", ["-m", "http.server", "8000"]);
  
  // Expose the port - hostname is automatically detected
  const pythonPreview = await sandbox.exposePort(8000, { name: "python-docs" });
  console.log("Python server exposed at:", pythonPreview.url);

  // Example 2: Start a Node.js Express server
  console.log("\nSetting up Node.js Express server...");
  
  // Create a simple Express app
  await sandbox.writeFile("/app.js", `
    const express = require('express');
    const app = express();
    
    app.get('/', (req, res) => {
      res.send('<h1>Hello from Express!</h1>');
    });
    
    app.get('/api/status', (req, res) => {
      res.json({ status: 'running', timestamp: new Date() });
    });
    
    app.listen(3001, () => {
      console.log('Express server running on port 3001');
    });
  `);
  
  // Install Express
  await sandbox.exec("npm", ["init", "-y"]);
  await sandbox.exec("npm", ["install", "express"]);
  
  // Start the server
  await sandbox.exec("node", ["/app.js"]);
  
  // Expose the Express server
  const expressPreview = await sandbox.exposePort(3001, { name: "express-api" });
  console.log("Express server exposed at:", expressPreview.url);

  // Example 3: List all exposed ports
  console.log("\nListing all exposed ports:");
  const exposedPorts = await sandbox.getExposedPorts();
  exposedPorts.forEach(port => {
    console.log(`- Port ${port.port} (${port.name}): ${port.url}`);
  });

  // Example 4: Unexpose a port
  console.log("\nUnexposing Python server...");
  await sandbox.unexposePort(8000);
  
  // List ports again
  const remainingPorts = await sandbox.getExposedPorts();
  console.log("Remaining exposed ports:", remainingPorts.length);
}

// Example Worker handler
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const hostname = url.hostname;
    
    // Handle preview URL requests (production/custom domains pattern)
    const previewMatch = hostname.match(/^(\d+)-([a-zA-Z0-9-]+)\./);
    if (previewMatch) {
      const port = parseInt(previewMatch[1]);
      const sandboxId = previewMatch[2];
      
      const sandbox = getSandbox(env.Sandbox, sandboxId);
      const proxyUrl = `http://localhost:3000/proxy/${port}${pathname}${url.search}`;
      
      return sandbox.containerFetch(new Request(proxyUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }));
    }
    
    // Handle localhost preview pattern: /preview/{port}/{sandbox-id}/*
    const localPreviewMatch = pathname.match(/^\/preview\/(\d+)\/([a-zA-Z0-9-]+)(\/.*)?$/);
    if (localPreviewMatch) {
      const port = parseInt(localPreviewMatch[1]);
      const sandboxId = localPreviewMatch[2];
      const subPath = localPreviewMatch[3] || "/";
      
      const sandbox = getSandbox(env.Sandbox, sandboxId);
      const proxyUrl = `http://localhost:3000/proxy/${port}${subPath}${url.search}`;
      
      return sandbox.containerFetch(new Request(proxyUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }));
    }
    
    // Demo endpoint
    if (url.pathname === "/demo-preview") {
      await demonstratePreviewUrls(env);
      return new Response("Preview URLs demo completed! Check the logs.", {
        headers: { "Content-Type": "text/plain" },
      });
    }
    
    return new Response("Preview URLs Example", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};