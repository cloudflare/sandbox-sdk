# Browser Automation with Sandbox SDK

A Cloudflare Worker example that uses the Chromium sandbox image to run headless browser automation inside Cloudflare Sandboxes.

## Features

- **Chromium Sandbox Image**: Uses the Chromium-capable Sandbox image variant for browser workloads
- **Headless Automation**: Launches Chrome in headless mode inside an isolated sandbox container
- **Screenshot Capture**: Returns a PNG screenshot from inside the sandbox
- **DOM Extraction**: Dumps page HTML and extracts the page title

## How It Works

1. A request is sent to the `/run` endpoint with a target URL
2. The Worker gets or creates a sandbox instance
3. Headless Chrome runs inside the sandbox container
4. Chrome captures a screenshot and dumps the page DOM
5. The Worker reads the screenshot file back from the sandbox and returns structured results

## API Endpoint

### Run Browser Automation

```bash
GET http://localhost:8787/run?url=https://example.com
```

Or:

```bash
POST http://localhost:8787/run
Content-Type: application/json

{
  "url": "https://example.com"
}
```

## Example Usage

```bash
# Visit the default URL (https://example.com)
curl http://localhost:8787/run

# Visit a specific page
curl "http://localhost:8787/run?url=https://developers.cloudflare.com"

# Use POST instead of query params
curl -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

The response includes:

```json
{
  "sandboxId": "browser-automation",
  "requestedUrl": "https://example.com/",
  "title": "Example Domain",
  "htmlPreview": "<!doctype html>...",
  "htmlLength": 1234,
  "screenshot": "data:image/png;base64,..."
}
```

## Setup

1. From the project root:

```bash
npm install
npm run build
npm run docker:rebuild
```

2. Run locally:

```bash
cd examples/browser-automation
npm run dev
```

> **Note:** The first run can take a few minutes because the Chromium container image must be built locally.

## Deploy

```bash
npm run deploy
```

> **Wait for provisioning:** After first deployment, wait a few minutes for container provisioning before making requests.
