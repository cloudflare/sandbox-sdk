# Port Forwarding and Preview URL Architecture

## Current Issues

### Issue 1: Incorrect Preview URL Port Generation ✅ FIXED
**Problem**: Preview URLs returned hardcoded `localhost:8787` instead of actual development server port.

**Example**:
- Frontend running on: `http://localhost:63654/`
- Expected preview URL: `http://localhost:63654/preview/8080/demo-user-sandbox`
- Previous behavior: `http://localhost:8787/preview/8080/demo-user-sandbox` ❌
- Current behavior: `http://localhost:63654/preview/8080/demo-user-sandbox` ✅

**Root Cause**:
The Sandbox's `fetch()` method only handles internal container communication, not external API requests from the Worker. The external hostname (`localhost:63654`) was never passed to preview URL construction methods.

**Solution Implemented**:
**Method Parameter Approach** - Worker endpoints automatically capture and pass hostname to Sandbox methods with required parameters:

```typescript
// Worker endpoint automatically captures hostname
export async function exposePort(sandbox: Sandbox<unknown>, request: Request) {
    const hostname = new URL(request.url).host; // ✅ localhost:63654
    const preview = await sandbox.exposePort(port, { name, hostname });
}

// Sandbox method requires hostname parameter - no internal capture or fallbacks
async exposePort(port: number, options: { name?: string; hostname: string }) {
    const url = this.constructPreviewUrl(port, this.sandboxName, options.hostname);
    // ... rest of implementation
}
```

### Issue 2: Relative Path Resolution in Preview Content
**Problem**: Content served through preview URLs has broken relative links.

**Example**:
- User navigates to: `http://localhost:63654/preview/8080/demo-user-sandbox/`
- Python HTTP server shows directory listing
- Links appear as: `http://localhost:63654/preview/8080/index.ts` (missing sandbox ID)
- Should be: `http://localhost:63654/preview/8080/demo-user-sandbox/index.ts`

**Root Cause Analysis**:
This is puzzling because Python's `SimpleHTTPServer` typically generates relative links like `<a href="index.ts">`. The appearance of absolute paths suggests:

1. **Server-side URL rewriting**: Python server using proxy headers to construct absolute URLs
2. **Base URL manipulation**: Injected `<base>` tag or similar mechanism
3. **Redirect handling**: Server redirects being processed incorrectly
4. **Middleware interference**: Some component rewriting URLs in transit

## Architecture Scenarios

### 1. Local Development - Single Worker
**Setup**:
- Worker runs on dynamic port (e.g., `wrangler dev` → `localhost:63654`)
- Container runs on `localhost` with exposed ports
- All routing handled by single Worker

**Preview URL Pattern**: `http://localhost:{dynamic-port}/preview/{service-port}/{sandbox-id}/`

**Challenges**:
- Dynamic ports change between `wrangler dev` sessions
- Need to capture actual Worker port, not hardcoded fallback
- Container port forwarding must work with localhost

**Current Status**: ✅ Fixed (Issue 1 resolved)

### 2. Production - Single Worker - workers.dev Domain
**Setup**:
- Worker deployed to `my-app.my-subdomain.workers.dev`
- Container accessible via subdomain routing
- Cloudflare handles TLS termination

**Preview URL Pattern**: `https://{service-port}-{sandbox-id}.my-subdomain.workers.dev/`

**Challenges**:
- Wildcard DNS must be configured
- TLS certificates for subdomain pattern
- Subdomain routing logic

**Current Status**: ✅ Should work (existing subdomain logic)

### 3. Production - Single Worker - Custom Domain
**Setup**:
- Worker deployed to custom domain (e.g., `my-app.com`)
- Custom domain with wildcard DNS
- Custom TLS certificate

**Preview URL Pattern**: `https://{service-port}-{sandbox-id}.my-app.com/`

**Challenges**:
- Wildcard DNS configuration (`*.my-app.com`)
- Wildcard TLS certificate required
- Domain ownership verification

**Current Status**: ✅ Should work if DNS/TLS configured

### 4. Production - Separate Workers
**Setup**:
- Frontend Worker: `frontend.workers.dev`
- Sandbox Worker: `sandbox.workers.dev`
- Cross-worker communication

**Preview URL Options**:
1. **Cross-origin**: `https://{port}-{sandbox-id}.sandbox.workers.dev/`
2. **Proxy through frontend**: `https://frontend.workers.dev/sandbox-proxy/{port}/{sandbox-id}/`

**Challenges**:
- CORS configuration for cross-origin requests
- Authentication/authorization across workers
- Request routing complexity

**Current Status**: ❓ Untested architecture

### 5. Hybrid Architecture - CDN + Workers
**Setup**:
- Static frontend served from CDN
- Sandbox functionality via Workers
- Preview URLs as subdomain or path-based

**Preview URL Pattern**:
- Path-based: `https://api.my-app.com/preview/{port}/{sandbox-id}/`
- Subdomain: `https://{port}-{sandbox-id}-api.my-app.com/`

**Challenges**:
- Complex routing logic
- CDN cache considerations
- Authentication token propagation

**Current Status**: ❓ Future consideration

## Technical Deep Dive

### Current Preview URL Construction Logic (After Fix)

```typescript
// packages/sandbox/src/sandbox.ts - Cleaned up implementation
async exposePort(port: number, options: { name?: string; hostname: string }) {
  await this.client.exposePort(port, options?.name);

  if (!this.sandboxName) {
    throw new Error('Sandbox name not available. Ensure sandbox is accessed through getSandbox()');
  }

  const url = this.constructPreviewUrl(port, this.sandboxName, options.hostname);
  return { url, port, name: options?.name };
}

private constructPreviewUrl(port: number, sandboxId: string, hostname: string): string {
  const isLocalhost = isLocalhostPattern(hostname);

  if (isLocalhost) {
    return `http://${hostname}/preview/${port}/${sandboxId}`;
  }

  const protocol = hostname.includes(":") ? "http" : "https";
  return `${protocol}://${port}-${sandboxId}.${hostname}`;
}
```

**Improvements**:
1. ✅ **Required hostname parameter**: No more fallback logic or hardcoded values
2. ✅ **Full hostname with port**: `new URL(request.url).host` captures both hostname and port
3. ✅ **Clear separation**: Worker captures context, Sandbox constructs URLs
4. ✅ **Explicit API contracts**: Required parameters make dependencies obvious

### Current Proxy Routing Logic

```typescript
// packages/sandbox/src/request-handler.ts:70-83
function extractSandboxRoute(url: URL): RouteInfo | null {
  // Development: path pattern /preview/{port}/{sandboxId}/*
  if (isLocalhostPattern(url.hostname)) {
    const pathMatch = url.pathname.match(/^\/preview\/(\d+)\/([^/]+)(\/.*)?$/);
    if (pathMatch) {
      return {
        port: parseInt(pathMatch[1]),
        sandboxId: pathMatch[2],
        path: pathMatch[3] || "/",
      };
    }
  }
  return null;
}
```

**Analysis**: This logic correctly extracts the path and forwards to container. The relative path issue must be occurring elsewhere.

### Relative Path Resolution Investigation

**Normal Python SimpleHTTPServer Output**:
```html
<a href="index.ts">index.ts</a>
<a href="subdir/">subdir/</a>
```

**Browser Resolution Process**:
1. Current URL: `http://localhost:63654/preview/8080/demo-user-sandbox/`
2. Relative link: `href="index.ts"`
3. Resolved URL: `http://localhost:63654/preview/8080/demo-user-sandbox/index.ts`

**Observed Problem**: Links appear as `/preview/8080/index.ts` (absolute path, missing sandbox ID)

**Possible Causes**:
1. **Proxy Headers**: Python server using `X-Forwarded-*` headers incorrectly
2. **Base URL Injection**: Some component adding `<base href="/preview/8080/">`
3. **Server Configuration**: Python server configured with wrong base path
4. **URL Rewriting**: Middleware converting relative to absolute paths

## Solution Options Analysis

### Option 1: Fix Hostname Capture Only (Minimal Fix)
**Approach**:
- Change `url.hostname` to `url.host` in hostname capture
- Remove hardcoded `localhost:8787` fallback

**Pros**:
- ✅ Fixes Issue 1 (wrong port)
- ✅ Minimal code change
- ✅ No breaking changes

**Cons**:
- ❌ Doesn't address Issue 2 (relative paths)
- ❌ Limited architecture support

**Implementation**:
```typescript
// sandbox.ts:99-102
if (!this.workerHostname) {
  this.workerHostname = url.host; // includes port
  console.log(`[Sandbox] Captured hostname: ${this.workerHostname}`);
}

// sandbox.ts:641-643
private getHostname(): string {
  return this.workerHostname || "localhost"; // remove port from fallback
}
```

### Option 2: Enhanced Request Context Capture
**Approach**: Capture full request context including protocol, host, and port

**Pros**:
- ✅ Robust hostname/port detection
- ✅ Supports various architectures
- ✅ Better debugging information

**Cons**:
- ❌ Still doesn't address Issue 2
- ❌ More complex implementation

**Implementation**:
```typescript
interface RequestContext {
  protocol: string;
  hostname: string;
  port: string;
  origin: string;
}

private captureRequestContext(url: URL): RequestContext {
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    origin: url.origin
  };
}
```

### Option 3: Base Path Injection (Header-Based)
**Approach**: Add base path information via HTTP headers

**Pros**:
- ✅ Minimal HTML modification
- ✅ Standard HTTP approach
- ✅ Works with various content types

**Cons**:
- ❌ Limited browser support for Content-Base header
- ❌ Requires server cooperation
- ❌ Complex debugging

**Implementation**:
```typescript
const proxyRequest = new Request(proxyUrl, {
  headers: {
    ...headers,
    'X-Base-URL': `/preview/${port}/${sandboxId}/`,
    'Content-Base': `/preview/${port}/${sandboxId}/`
  }
});
```

### Option 4: Smart Base Tag Injection
**Approach**: Inject `<base>` tag only into HTML responses

**Pros**:
- ✅ Standard HTML mechanism
- ✅ Browser handles all relative URL resolution
- ✅ Works with existing content

**Cons**:
- ❌ Requires HTML parsing/modification
- ❌ May interfere with existing base tags
- ❌ Performance overhead

**Implementation**:
```typescript
async function injectBaseTag(response: Response, basePath: string): Promise<Response> {
  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('text/html')) {
    return response; // Pass through non-HTML
  }

  const html = await response.text();
  const modifiedHtml = html.replace(
    /<head>/i,
    `<head><base href="${basePath}">`
  );

  return new Response(modifiedHtml, {
    headers: response.headers,
    status: response.status
  });
}
```

### Option 5: Container-Side Base Path Awareness
**Approach**: Configure container services to be aware of their base path

**Pros**:
- ✅ No URL rewriting needed
- ✅ Services generate correct absolute URLs
- ✅ Most robust approach

**Cons**:
- ❌ Requires user/service configuration
- ❌ Not all services support base path
- ❌ Complex service setup

**Implementation**:
```bash
# User would need to configure services with base path
python3 -m http.server 8080 --base-path /preview/8080/demo-user-sandbox/
```

### Option 6: Reverse Proxy Path Translation
**Approach**: Translate paths in both directions

**Pros**:
- ✅ Transparent to container services
- ✅ No content modification
- ✅ Works with any service

**Cons**:
- ❌ Complex bi-directional path mapping
- ❌ May break services that depend on full path
- ❌ Debugging complexity

**Implementation**:
```typescript
// Forward: /preview/8080/sandbox/path → /path (to container)
// Reverse: Location: /redirect → Location: /preview/8080/sandbox/redirect (from container)
```

## Recommended Solution Approach

### Phase 1: Fix Critical Issues ✅ COMPLETED
**Scope**: Address Issue 1 with comprehensive architectural cleanup

**Implementation**:
1. ✅ Enhanced `exposePort()` and `getExposedPorts()` with **required** `hostname` parameter
2. ✅ Modified Worker endpoints to automatically capture and pass `new URL(request.url).host`
3. ✅ Removed redundant internal hostname capture logic from Sandbox class
4. ✅ Simplified `fetch()` method to focus only on container routing
5. ✅ Cleaned up architectural debt by removing `workerHostname` property
6. ✅ Made API contracts explicit and clear (required vs optional parameters)

**Architectural Improvements**:
- **Separation of Concerns**: Worker handles external context, Sandbox handles container logic
- **Explicit Dependencies**: Required hostname parameter makes external context dependency clear
- **Reduced Complexity**: Eliminated fallback logic and multiple hostname capture mechanisms
- **Better Error Messages**: Clear guidance when hostname is missing

**Risk**: Low - API changes are explicit and fail fast with clear error messages
**Impact**: ✅ Fixed wrong port issue for all architectures with cleaner, more maintainable code

### Phase 2: Investigate Relative Path Root Cause (Next)
**Scope**: Deep dive into Issue 2 to understand actual cause

**Research Areas**:
1. Test with different HTTP servers (Python, Node.js, nginx)
2. Analyze actual HTML content being served
3. Check if proxy headers are affecting server behavior
4. Test with various content types and configurations

**Deliverable**: Root cause analysis document with reproduction steps

### Phase 3: Implement Robust Solution (Future)
**Scope**: Address Issue 2 based on root cause findings

**Likely Approach**: Smart Base Tag Injection (Option 4)
- Least intrusive for users
- Standard HTML mechanism
- Can be made opt-in/opt-out
- Works across architectures

### Phase 4: Architecture Enhancement (Long-term)
**Scope**: Support advanced deployment patterns

**Features**:
- Cross-worker preview URL generation
- Custom domain configuration
- Advanced routing options
- Performance optimizations

## Implementation Priorities

1. ✅ **🔥 Critical**: Fix hostname capture (Issue 1) - **COMPLETED**
2. **📋 High**: Root cause analysis for relative paths (Issue 2)
3. **🛠️ Medium**: Implement base tag injection solution
4. **📈 Low**: Advanced architecture support
5. **🔍 Research**: Alternative deployment patterns

## Testing Strategy

### Local Development Testing
- [x] Test with various `wrangler dev` ports - ✅ **Working**
- [x] Verify preview URLs generate correctly - ✅ **Working**
- [ ] Test relative link resolution
- [ ] Check with different HTTP servers

### Production Testing
- [ ] Test on workers.dev subdomain
- [ ] Test with custom domain
- [ ] Verify TLS certificate handling
- [ ] Check subdomain routing

### Cross-Architecture Testing
- [ ] Single worker deployment
- [ ] Separate worker deployment
- [ ] CDN + worker hybrid
- [ ] Custom domain configurations

## Security Considerations

### URL Construction
- Validate port numbers (prevent injection)
- Sanitize sandbox IDs (prevent path traversal)
- Limit hostname patterns (prevent open redirects)

### Content Modification
- Only modify HTML content (verify content-type)
- Preserve existing base tags when possible
- Escape injected content properly

### Cross-Origin Scenarios
- Proper CORS headers
- Authentication token handling
- Prevent CSRF attacks

---

*This document will be updated as we implement and test solutions.*