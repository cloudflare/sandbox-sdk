# Cloudflare Sandbox SDK Example

A comprehensive example demonstrating the proper architecture and usage patterns for the Cloudflare Sandbox SDK. This interactive web application showcases command execution, process management, and real-time streaming capabilities.

![Screenshot](https://github.com/user-attachments/assets/e418b24c-529c-4cec-8272-ae4e242ba2e0)

## Features

- **Command Execution**: Execute commands with both immediate results and streaming output
- **Process Management**: Start, monitor, and manage background processes
- **Real-time Streaming**: Live output from long-running commands and processes
- **Port Exposure**: Expose container ports with public preview URLs
- **Interactive UI**: Modern React interface with tabbed navigation for different SDK features

## Quick Start

1. **Install dependencies**:

   ```bash
   npm install
   ```

2. **Start development server**:

   ```bash
   npm start
   ```

3. **Open your browser** and navigate to the URL shown in the terminal (typically `http://localhost:8787`)

4. **Explore the interface**:
   - **Commands**: Execute one-off commands with immediate or streaming results
   - **Processes**: Start and manage background processes
   - **Ports**: Expose container ports and get public URLs
   - **Streaming**: Monitor real-time output from running processes

## Architecture

This example demonstrates the proper 3-layer architecture for Sandbox SDK applications:

```
┌─────────────┐   HTTP    ┌─────────────┐  Direct   ┌─────────────┐
│ React App   │ ────────▶ │   Worker    │ ────────▶ │ Sandbox DO  │
│ (Frontend)  │           │ (API Layer) │  Method   │ (SDK Logic) │
│             │◀──────────│             │  Calls    │             │
└─────────────┘  JSON/SSE └─────────────┘           └─────────────┘
```

### Layer Responsibilities

**Frontend (`app/index.tsx`)**
- React-based UI with tabbed interface
- HTTP requests to Worker API endpoints
- Server-Sent Events for real-time streaming
- State management for commands, processes, and ports

**Worker (`src/index.ts`)**
- HTTP API gateway with endpoint routing
- Direct calls to Sandbox SDK methods
- SSE streaming for real-time updates
- CORS handling and error responses

**Sandbox Durable Object**
- Implements ISandbox interface methods
- Process lifecycle management
- AsyncIterable streaming capabilities
- Container communication and port exposure

## Deployment

Containers on Cloudflare are currently [in public beta](https://blog.cloudflare.com/containers-are-available-in-public-beta-for-simple-global-and-programmable), available for all paid accounts. If you have one, you can simply run:

```bash
npm run deploy
```

## Development

### Project Structure
```
examples/basic/
├── src/
│   ├── index.ts              # Worker entry point
│   └── endpoints/            # API endpoint handlers
├── app/
│   ├── index.tsx            # React frontend
│   └── style.css            # UI styling
├── Dockerfile               # Container configuration
└── wrangler.jsonc          # Cloudflare configuration
```

### Key Implementation Notes

- **Direct SDK Usage**: Worker calls SDK methods directly (not internal APIs)
- **AsyncIterable Streaming**: Proper use of `parseSSEStream` for real-time updates
- **Error Handling**: Comprehensive error responses and UI feedback
- **Process Lifecycle**: Demonstrates proper background process management

### Testing Different Features

1. **Commands Tab**: Test `exec()` and `execStream()` methods
2. **Processes Tab**: Start/stop background processes and stream their logs
3. **Ports Tab**: Expose container ports and access via preview URLs
4. **Streaming Tab**: Real-time output from long-running commands

### Common Use Cases Shown

- **Build Systems**: Stream build output with `npm run build`
- **Development Servers**: Start processes like `npm run dev`
- **Log Monitoring**: Stream logs from background services
- **Port Forwarding**: Expose web servers running in containers
