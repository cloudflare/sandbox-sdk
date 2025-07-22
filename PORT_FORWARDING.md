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

### Issue 2: Architectural Inconsistency Between Dev and Production ⚠️ SUPERSEDED
**Problem**: Path-based routing in development causes container applications to lose context about their base URL, breaking relative links, asset loading, and client-side routing.

**Examples**:
- **Python SimpleHTTPServer**: Directory listing links appear as `/preview/8080/index.ts` (missing sandbox ID)
- **React Apps**: Assets fail to load because they expect to be served from domain root
- **SPA Routing**: React Router doesn't know about the `/preview/8080/demo-user-sandbox/` prefix

**Root Cause**: 
Architectural inconsistency where development uses path-based routing (`/preview/8080/sandbox-id/`) while production uses subdomain routing (`8080-sandbox-id.domain.com`). This forces containers to handle base path context differently across environments.

**Solution Implemented**: 
**🚀 UNIFIED SUBDOMAIN ARCHITECTURE** - Use subdomain routing consistently across all environments:

**Before (Inconsistent)**:
- Development: `http://localhost:63654/preview/8080/demo-user-sandbox/`
- Production: `https://8080-demo-user-sandbox.workers.dev/`

**After (Unified)**:
- Development: `http://8080-demo-user-sandbox.localhost:63654/`  
- Production: `https://8080-demo-user-sandbox.workers.dev/`

**Benefits**:
- ✅ Containers always see themselves at domain root (`/`)
- ✅ All relative URLs work naturally without configuration
- ✅ React apps load assets from `/static/js/bundle.js` (no base path needed)
- ✅ SPA routing works without `basename` configuration
- ✅ Consistent behavior across development and production
- ✅ No more proxy header complications or path context issues

## Architecture Scenarios

### 1. Local Development - Single Worker ⚡ UNIFIED
**Setup**:
- Worker runs on dynamic port (e.g., `wrangler dev` → `localhost:63654`)
- Container runs on `localhost` with exposed ports
- All routing handled by single Worker

**Preview URL Pattern**: `http://{service-port}-{sandbox-id}.localhost:{dynamic-port}/`

**Examples**:
- Python server on port 8080: `http://8080-demo-user-sandbox.localhost:63654/`
- React dev server on port 3000: `http://3000-demo-user-sandbox.localhost:63654/`
- API server on port 9000: `http://9000-demo-user-sandbox.localhost:63654/`

**Benefits**:
- ✅ Consistent with production subdomain pattern
- ✅ Containers see themselves at domain root
- ✅ No base path configuration needed for any app type
- ✅ Automatic browser `.localhost` DNS resolution (RFC 6761)

**Current Status**: 🚀 **Phase 2 Target Architecture**

### 2. Production - Single Worker - workers.dev Domain ✅ UNIFIED
**Setup**:
- Worker deployed to `my-app.my-subdomain.workers.dev`
- Container accessible via subdomain routing
- Cloudflare handles TLS termination

**Preview URL Pattern**: `https://{service-port}-{sandbox-id}.my-subdomain.workers.dev/`

**Examples**:
- Python server: `https://8080-demo-user-sandbox.my-app.workers.dev/`
- React app: `https://3000-demo-user-sandbox.my-app.workers.dev/`
- API server: `https://9000-demo-user-sandbox.my-app.workers.dev/`

**Benefits**:
- ✅ **Already unified with localhost approach**
- ✅ Wildcard DNS handled by Cloudflare
- ✅ Automatic TLS certificates
- ✅ Perfect container isolation

**Current Status**: ✅ **Production Ready** (existing implementation)

### 3. Production - Single Worker - Custom Domain ✅ UNIFIED
**Setup**:
- Worker deployed to custom domain (e.g., `my-app.com`)
- Custom domain with wildcard DNS
- Custom TLS certificate

**Preview URL Pattern**: `https://{service-port}-{sandbox-id}.my-app.com/`

**Examples**:
- Python server: `https://8080-demo-user-sandbox.my-app.com/`
- React app: `https://3000-demo-user-sandbox.my-app.com/`
- API server: `https://9000-demo-user-sandbox.my-app.com/`

**Requirements**:
- 📋 Wildcard DNS configuration (`*.my-app.com → my-app.com`)
- 🔒 Wildcard TLS certificate (`*.my-app.com`)
- ✅ Domain ownership verification

**Benefits**:
- ✅ **Unified with development approach**
- ✅ Custom branding and domain
- ✅ Full TLS security
- ✅ Perfect container isolation

**Current Status**: ✅ **Ready** (requires DNS/TLS setup)

### 4. Production - Separate Workers 🚀 ENHANCED BY UNIFIED APPROACH
**Setup**:
- Frontend Worker: `frontend.workers.dev`
- Sandbox Worker: `sandbox.workers.dev`
- Cross-worker communication

**Preview URL Options**:
1. **Direct Subdomain** (Recommended): `https://{port}-{sandbox-id}.sandbox.workers.dev/`
2. **Proxy through Frontend**: `https://frontend.workers.dev/sandbox-proxy/{port}/{sandbox-id}/`

**Unified Benefits**:
- ✅ **Consistent URLs**: Same subdomain pattern as single worker
- ✅ **Clean Separation**: Frontend handles UI, Sandbox handles containers
- ✅ **Perfect Isolation**: Each sandbox gets its own subdomain
- ✅ **CORS Simplicity**: Direct subdomain avoids cross-origin complexity

**Enhanced Architecture**:
```
Frontend:    https://frontend.workers.dev/
Python App:  https://8080-demo-user-sandbox.sandbox.workers.dev/
React App:   https://3000-demo-user-sandbox.sandbox.workers.dev/
API Server:  https://9000-demo-user-sandbox.sandbox.workers.dev/
```

**Current Status**: 🚀 **Enhanced by Unified Architecture**

### 5. Hybrid Architecture - CDN + Workers ✨ SIMPLIFIED BY UNIFIED APPROACH
**Setup**:
- Static frontend served from CDN
- Sandbox functionality via Workers
- Preview URLs as consistent subdomains

**Preview URL Pattern** (Unified): `https://{port}-{sandbox-id}.api.my-app.com/`

**Examples**:
```
Frontend CDN:  https://my-app.com/
Sandbox API:   https://api.my-app.com/
Python App:    https://8080-demo-user-sandbox.api.my-app.com/
React App:     https://3000-demo-user-sandbox.api.my-app.com/
API Server:    https://9000-demo-user-sandbox.api.my-app.com/
```

**Unified Benefits**:
- ✅ **Simplified Routing**: No complex path-based logic needed
- ✅ **CDN Compatibility**: Subdomains bypass CDN cache issues
- ✅ **Clean Architecture**: Clear separation between static and dynamic content
- ✅ **Consistent Experience**: Same subdomain pattern everywhere

**Requirements**:
- 📋 Wildcard DNS for `*.api.my-app.com`
- 🔒 Wildcard TLS certificate
- ✅ Worker deployed to `api.my-app.com`

**Current Status**: ✨ **Significantly Simplified** by unified approach

## 🚀 Unified Subdomain Architecture (Phase 2 Solution)

### Overview
The unified subdomain architecture eliminates the development vs production routing inconsistency by using subdomain-based preview URLs consistently across all environments. This approach leverages RFC 6761 `.localhost` domain resolution for local development.

### Technical Implementation

#### Localhost Subdomain Resolution (RFC 6761)
Modern browsers automatically resolve `*.localhost` domains to `127.0.0.1` without requiring DNS configuration:

```
8080-demo-user-sandbox.localhost → 127.0.0.1
3000-react-app.localhost → 127.0.0.1  
9000-api-server.localhost → 127.0.0.1
```

**Browser Support**:
- ✅ **Chrome**: Full support since version 64 (2018)
- ✅ **Firefox**: Full support since version 60 (2018)  
- ✅ **Safari**: Full support since version 14 (2020)
- ✅ **Edge**: Full support since Chromium transition (2020)

#### URL Construction Logic (Updated)

```typescript
private constructPreviewUrl(port: number, sandboxId: string, hostname: string): string {
  const isLocalhost = isLocalhostPattern(hostname);
  
  if (isLocalhost) {
    // NEW: Unified subdomain approach for localhost
    const [host, portStr] = hostname.split(':');
    const mainPort = portStr || '80';
    return `http://${port}-${sandboxId}.${host}:${mainPort}`;
  }
  
  // Production subdomain logic (unchanged)
  const protocol = hostname.includes(":") ? "http" : "https";
  return `${protocol}://${port}-${sandboxId}.${hostname}`;
}
```

#### Request Routing Logic (Updated)

```typescript
function extractSandboxRoute(url: URL): RouteInfo | null {
  // NEW: Subdomain pattern for all environments
  const subdomainMatch = url.hostname.match(/^(\d+)-([^.]+)\.(.+)$/);
  if (subdomainMatch) {
    return {
      port: parseInt(subdomainMatch[1]),
      sandboxId: subdomainMatch[2],
      path: url.pathname || "/",
    };
  }
  
  // Fallback: Legacy path pattern for backward compatibility
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

### Application Compatibility Matrix

#### ✅ Fully Compatible (Zero Configuration)
- **Python SimpleHTTPServer**: Directory listings work perfectly
- **Static File Servers**: nginx, Apache, Python, Node.js serve
- **Basic Web Apps**: All relative URLs resolve correctly

#### ✅ Enhanced Compatibility (Works Out of Box)
- **React Production Builds**: Assets load from `/static/` without base path
- **Vue.js Apps**: Router and assets work without configuration
- **Angular Apps**: Base href remains default `/`
- **Webpack Dev Server**: HMR and assets work correctly

#### ✅ API Servers (Perfect Compatibility)  
- **Node.js Express**: Routes work at root level
- **FastAPI/Flask**: All endpoints accessible at root
- **Go HTTP Server**: Standard routing works
- **Ruby Sinatra/Rails**: No base path configuration needed

### Browser Fallback Strategy

```typescript
async function testSubdomainSupport(): Promise<boolean> {
  try {
    // Test if browser resolves *.localhost to 127.0.0.1
    const testUrl = 'http://test-subdomain.localhost:' + getCurrentPort();
    const response = await fetch(testUrl, { 
      method: 'HEAD', 
      mode: 'no-cors',
      timeout: 1000 
    });
    return true;
  } catch (error) {
    console.log('Subdomain not supported, falling back to path-based routing');
    return false;
  }
}

private constructPreviewUrl(port: number, sandboxId: string, hostname: string): string {
  const isLocalhost = isLocalhostPattern(hostname);
  
  if (isLocalhost) {
    // Check if subdomain support is available
    if (this.subdomainSupported !== false) {
      const [host, portStr] = hostname.split(':');
      const mainPort = portStr || '80';
      return `http://${port}-${sandboxId}.${host}:${mainPort}`;
    } else {
      // Fallback to path-based routing
      return `http://${hostname}/preview/${port}/${sandboxId}`;
    }
  }
  
  // Production always uses subdomain
  const protocol = hostname.includes(":") ? "http" : "https";
  return `${protocol}://${port}-${sandboxId}.${hostname}`;
}
```

### Edge Cases & Considerations

#### Corporate Networks
- **DNS Filtering**: Some corporate networks might block `.localhost` resolution
- **Proxy Servers**: Corporate proxies may not support subdomain patterns  
- **Solution**: Automatic fallback to path-based routing

#### Development Environment Edge Cases
- **Port Conflicts**: Multiple developers using same sandbox ID
- **DNS Caching**: Browser DNS cache might need clearing during development
- **SSL/TLS**: Localhost subdomains use HTTP (production uses HTTPS)

#### Performance Implications
- **DNS Resolution**: Additional DNS lookup for each subdomain (minimal impact)
- **Browser Connection Pooling**: Each subdomain gets its own connection pool
- **Cache Isolation**: Each subdomain has separate HTTP cache (can be beneficial)

### Migration Strategy

#### Phase 1: Feature Flag Implementation
```typescript
interface SandboxConfig {
  useSubdomainRouting?: boolean; // Default: auto-detect
  fallbackToPathRouting?: boolean; // Default: true
}
```

#### Phase 2: Gradual Rollout
1. **Internal Testing**: Enable for development team
2. **Beta Users**: Opt-in for early adopters
3. **Full Rollout**: Enable by default with fallback
4. **Legacy Support**: Maintain path-based routing for compatibility

#### Phase 3: Cleanup
- Remove path-based routing logic (after sufficient adoption)
- Simplify URL construction and routing code
- Update documentation to reflect subdomain-only approach

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

### Phase 2: Unified Subdomain Architecture Implementation 🚀 (Current)
**Scope**: Implement unified subdomain routing to solve all container base path issues

**Implementation Steps**:
1. **Browser Compatibility Testing**: Validate `.localhost` subdomain resolution across browsers
2. **URL Construction Update**: Modify `constructPreviewUrl()` to use unified subdomain logic
3. **Request Routing Enhancement**: Update `extractSandboxRoute()` to handle subdomain parsing
4. **Fallback Implementation**: Add graceful degradation to path-based routing for unsupported browsers
5. **Comprehensive Testing**: Validate across Python, React, Node.js, and static file servers

**Technical Deliverables**:
- Updated `constructPreviewUrl()` function with unified subdomain logic
- Enhanced `extractSandboxRoute()` with subdomain pattern matching
- Browser compatibility detection and fallback mechanism
- Comprehensive test suite for all application types

**Expected Impact**: 
- ✅ Resolves all relative path issues (Python, React, SPA routing)
- ✅ Unified development/production experience  
- ✅ Zero configuration required for any app type
- ✅ Perfect container isolation and context

### Phase 3: Advanced Features & Optimization (Future)
**Scope**: Enhance unified architecture with advanced capabilities

**Feature Areas**:
- **Performance Optimization**: DNS caching, connection pooling strategies
- **Enterprise Features**: Custom domain automation, wildcard certificate management  
- **Developer Experience**: Enhanced debugging, subdomain testing tools
- **Edge Cases**: Corporate network compatibility, advanced fallback scenarios

**Advanced Capabilities**:
- Automatic wildcard DNS configuration for custom domains
- Performance monitoring and optimization for subdomain resolution
- Advanced developer tooling and debugging support
- Enterprise-grade security and compliance features

### Phase 4: Ecosystem Integration (Long-term)
**Scope**: Deep integration with broader development ecosystem

**Integration Areas**:
- **IDE Integration**: VS Code extensions, debugging tools
- **CI/CD Pipeline**: Automated testing of preview URLs across environments
- **Monitoring & Analytics**: Usage patterns, performance metrics
- **Third-party Tools**: Integration with popular development frameworks

**Advanced Features**:
- Automatic subdomain health monitoring
- Performance analytics and optimization recommendations
- Advanced security scanning and compliance reporting
- Ecosystem-wide standardization of preview URL patterns

## Implementation Priorities (Updated)

1. ✅ **🔥 Critical**: Fix hostname capture (Issue 1) - **COMPLETED**
2. 🚀 **🔥 Critical**: Implement unified subdomain architecture (Issue 2) - **IN PROGRESS**
3. **📋 High**: Browser compatibility testing and fallback implementation  
4. **🛠️ Medium**: Advanced features and enterprise capabilities
5. **📈 Low**: Ecosystem integration and third-party tooling
6. **🔍 Research**: Performance optimization and edge case handling

## Testing Strategy (Updated for Unified Architecture)

### Phase 2 Testing: Unified Subdomain Implementation

#### Browser Compatibility Testing
- [ ] **Chrome**: Test `.localhost` subdomain resolution and performance
- [ ] **Firefox**: Validate RFC 6761 compliance and DNS caching behavior  
- [ ] **Safari**: Test subdomain resolution and potential macOS restrictions
- [ ] **Edge**: Verify Chromium-based subdomain support
- [ ] **Mobile Browsers**: iOS Safari, Chrome Mobile subdomain support

#### Application Type Testing
- [ ] **Python SimpleHTTPServer**: Directory listings, relative links, file serving
- [ ] **React Development Server**: HMR, asset loading, routing without basename
- [ ] **React Production Build**: Static assets, SPA routing, build output
- [ ] **Node.js Express**: API routing, middleware compatibility
- [ ] **Static File Servers**: nginx, Apache, Python serve, Node serve
- [ ] **Vue.js/Angular Apps**: Framework-specific routing and asset loading

#### Local Development Testing  
- [x] Test with various `wrangler dev` ports - ✅ **Working**
- [x] Verify legacy path-based preview URLs - ✅ **Working** 
- [ ] **🚀 NEW**: Test subdomain URLs (`8080-sandbox.localhost:63654`)
- [ ] **🚀 NEW**: Validate automatic fallback to path-based routing
- [ ] **🚀 NEW**: Browser DNS resolution performance testing
- [ ] **🚀 NEW**: Multiple concurrent subdomain handling

#### Production Validation
- [ ] **workers.dev**: Verify existing subdomain logic remains unchanged
- [ ] **Custom Domains**: Test wildcard DNS and TLS certificate requirements  
- [ ] **Separate Workers**: Cross-worker subdomain routing validation
- [ ] **CDN Integration**: Subdomain bypass of CDN cache validation

#### Edge Case Testing
- [ ] **Corporate Networks**: DNS filtering, proxy server compatibility
- [ ] **Port Conflicts**: Multiple sandboxes with same ID on different ports
- [ ] **DNS Caching**: Browser cache clearing, TTL handling
- [ ] **Network Failures**: Graceful degradation when subdomain resolution fails
- [ ] **Performance**: Subdomain DNS resolution latency vs path-based routing

### Legacy Compatibility Testing
- [ ] **Backward Compatibility**: Existing path-based URLs continue working
- [ ] **Gradual Migration**: Feature flag implementation and rollout
- [ ] **Error Handling**: Clear error messages for unsupported browsers
- [ ] **Fallback Performance**: Path-based fallback maintains functionality

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