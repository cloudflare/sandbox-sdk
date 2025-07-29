# Port Access Control Security Fix

## **Critical Security Issue**
The expose/unexpose functionality tracks state correctly but doesn't enforce access control. Users can access ANY port by guessing the preview URL pattern, completely bypassing the SDK's security model.

## **Root Cause Analysis**

### **Current Broken Flow:**
1. User accesses `http://3001-sandbox.localhost:5173/`
2. `request-handler.ts` extracts port `3001` from URL  
3. **SECURITY GAP**: `proxyToSandbox()` calls `sandbox.containerFetch()` **WITHOUT** checking if port is exposed
4. Container receives request and serves it directly - **no access control**

### **The Issue:**
- **Access control exists** in `handleProxyRequest()` (container_src/handler/ports.ts:240-253) ✅
- **But it's bypassed** by the preview URL routing in `request-handler.ts` ❌

```typescript
// Container HAS access control (but only for /proxy/ paths):
if (!exposedPorts.has(port)) {
  return new Response(JSON.stringify({ error: `Port ${port} is not exposed` }), { status: 404 });
}

// But request-handler.ts BYPASSES this entirely:
return sandbox.containerFetch(proxyRequest, port); // ❌ No access control check
```

## **Security Impact:**
- ✅ Expose/unexpose **state is tracked correctly**
- ❌ Expose/unexpose **access control is not enforced** 
- ❌ Users can access **ANY port** if they guess the URL pattern
- ❌ Unexposed ports remain **fully accessible**

## **Solution: Enforce Access Control in Preview URL Routing**

### **Phase 1: Add Access Control Check to request-handler.ts**
1. **Add exposed ports check** before calling `containerFetch()`
2. **Query sandbox** for exposed ports state  
3. **Return 403/404** if port is not exposed
4. **Maintain existing functionality** for exposed ports

### **Phase 2: Implement Sandbox Method for Port Access Control**
1. **Add `isPortExposed(port)` method** to Sandbox class
2. **Check against client.ports.getExposedPorts()** state
3. **Return boolean** for access control decisions

### **Phase 3: Update Preview URL Logic**
1. **Modify `proxyToSandbox()`** in request-handler.ts
2. **Add access control check**: `if (!await sandbox.isPortExposed(port)) return 403`
3. **Preserve existing flow** for exposed ports
4. **Add security logging** for unauthorized access attempts

### **Phase 4: Testing & Validation**
1. **Test unexposed ports** return 403/404
2. **Test exposed ports** work normally  
3. **Test expose/unexpose** enables/disables access
4. **Verify backward compatibility** maintained

## **Files to Modify:**
- `packages/sandbox/src/request-handler.ts` - Add access control check
- `packages/sandbox/src/sandbox.ts` - Add `isPortExposed()` method
- Security logging and error responses

## **Expected Outcome:**
- ✅ Unexposed ports will be **truly inaccessible**
- ✅ Exposed ports work normally
- ✅ SDK security model **properly enforced**
- ✅ No breaking changes to public API

---

## **Secondary Security Concern: Guessable Preview URLs**

The current URL pattern `{port}-{sandboxId}.{domain}` is **guessable** and presents a **secondary security concern**:

### **Predictability Factors:**
1. **Ports**: Often standard (3000, 8080, 3001, etc.)
2. **Sandbox IDs**: Might be predictable patterns
3. **Domain**: Known domain structure

### **Security Implications:**
- **🔴 High Risk**: If ports are accessible without proper access control (current state)
- **🟡 Medium Risk**: Even with access control, attackers can still probe for exposed ports
- **🟢 Low Risk**: If combined with proper access control + additional security measures

### **Potential Solutions:**
1. **Immediate**: Fix the access control (primary issue)
2. **Enhanced**: Add unpredictable tokens to URLs: `{port}-{sandboxId}-{token}.{domain}`
3. **Advanced**: Implement request signatures or session-based authentication

### **Recommendation:**
1. **Fix the access control first** (primary security gap)
2. **Consider URL tokens** as a secondary hardening measure
3. **Monitor access patterns** for suspicious probing

The guessable URLs are a concern, but the **lack of access control enforcement** is the critical issue that needs immediate attention.

---

## **Implementation Progress:**

### **Phase 1: Critical Access Control Fix** ✅ **COMPLETED**
- [x] Add `isPortExposed(port)` method to Sandbox class
- [x] Modify `proxyToSandbox()` to check port access before routing
- [x] Add security logging for unauthorized access attempts
- [x] Return proper 403/404 responses for unauthorized access

### **Phase 2: URL Token Security Enhancement** 🚧 **IN PROGRESS**

#### **Guessable Preview URL Analysis**

**Current Vulnerability**: Preview URLs follow predictable pattern `{port}-{sandboxId}.{domain}`
- **Port enumeration**: Common ports (3000, 8080, 3001, etc.) are easily guessable
- **Sandbox ID discovery**: Attackers can probe for active sandboxes
- **Information leakage**: Even with access control, reveals which sandboxes/ports exist
- **Risk Level**: Medium (access control blocks access but allows reconnaissance)

#### **Implemented Solution: Mandatory URL Tokens** ⚠️ **BREAKING CHANGE**
**New Pattern**: `{port}-{sandboxId}-{token}.{domain}` (tokens mandatory)
**Example**: `3001-my-sandbox-k7x9mw2p.example.com`

**Security Benefits**:
- Makes port discovery computationally infeasible
- Prevents sandbox enumeration attacks
- Maintains URL sharing capability
- Cryptographically unpredictable tokens

**Breaking Changes**:
- All preview URLs now require tokens
- Old URLs without tokens will return 404
- No backward compatibility with legacy URLs

#### **Implementation Phases**:

**Phase 2.1: Token Generation & Storage** ✅ **COMPLETED**
- [x] Add `generatePortToken()` method for cryptographically secure tokens (16+ chars)
- [x] Modify `Sandbox.exposePort()` to generate and store port→token mapping
- [x] Update container storage to persist port tokens
- [x] Modify `Sandbox.constructPreviewUrl()` to include tokens in URLs (mandatory)
- [x] All ports now require mandatory tokens (no legacy support)

**Phase 2.2: Token Validation** ✅ **COMPLETED**
- [x] Update `request-handler.ts` `extractSandboxRoute()` to parse token from subdomain
- [x] Add `validatePortToken()` method with constant-time comparison
- [x] Add token validation before port access control check
- [x] Return 404 for invalid/missing tokens (same as unexposed ports)
- [x] Add security logging for token validation failures

**Phase 2.3: Token Management** ✅ **COMPLETED**
- [x] Add token cleanup when ports are unexposed
- [x] Enforce mandatory tokens for all exposed ports
- [ ] Add optional token regeneration endpoint (future enhancement)

**Phase 2.4: Testing & Validation**
- [ ] Test token generation, validation, and cleanup  
- [x] Breaking change approach - no backward compatibility needed
- [x] Tokens are always enabled (no configuration flag needed)
- [x] New URL format documented above

### **Phase 3: Advanced Security (Future)**
- [ ] Consider session-based authentication
- [ ] Implement access monitoring and rate limiting
- [ ] Evaluate request signatures for additional security