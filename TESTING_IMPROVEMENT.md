# Testing Improvement Plan

## Problem Statement

The current testing approach using vitest + workers + containers has fundamental incompatibilities:

1. **Storage Isolation Issues**: Docker containers persist beyond test runs, violating Workers runtime expectations for isolated storage
2. **Resource Management Conflicts**: Container lifecycle doesn't align with Workers testing framework cleanup expectations
3. **Missing Coverage**: The `container_src/` directory (actual container runtime) isn't being tested independently
4. **Framework Limitations**: vitest-pool-workers has known issues with containers, WebSockets, and isolated storage

## Proposed Solution: Independent Layer Testing Strategy

Instead of testing everything together through complex integration, we test each layer independently and use lightweight mocking for integration validation.

### Phase 1: Container Layer Testing (New)

**Objective**: Test `container_src/` handlers independently without Docker or Workers runtime

**Approach**: Direct HTTP testing using Node.js + native fetch/supertest
- Start a standalone Bun server in test environment
- Send direct HTTP requests to container endpoints
- Mock file system operations and process spawning
- Validate HTTP routing, error responses, request/response formats

**Benefits**:
- No Docker containers required
- No Workers runtime complexity
- Fast execution (~2-5 seconds)
- Reliable resource cleanup
- True unit testing of container logic

**Test Structure**:
```
src/__tests__/container-unit/
├── handlers/
│   ├── exec-handler.test.ts      # Test command execution endpoints
│   ├── file-handler.test.ts      # Test file operation endpoints
│   ├── process-handler.test.ts   # Test process management endpoints
│   ├── port-handler.test.ts      # Test port exposure endpoints
│   └── git-handler.test.ts       # Test git operation endpoints
├── routing.test.ts               # Test HTTP routing logic
├── session-management.test.ts    # Test session creation/cleanup
├── error-responses.test.ts       # Test structured error responses
└── cors-headers.test.ts          # Test CORS handling
```

**Implementation Details**:
- ✅ **COMPLETED**: Create `src/__tests__/container-unit/test-server.ts` - Bun server for testing
- ✅ **COMPLETED**: Implement hybrid approach using Bun test for container logic
- Mock Node.js APIs (fs, child_process) using Bun's mocking system
- Use fetch() to make HTTP requests directly to container endpoints
- Validate response structure matches client expectations
- Test error conditions and edge cases without real file system

**✅ PROGRESS UPDATE - Phase 1 Started**:
- **Hybrid Testing Approach Implemented**: Using Bun test for container unit tests + Vitest for everything else
- **Test Server Created**: `ContainerTestServer` class with full container endpoint simulation
- **Routing Tests Passing**: 15/15 tests passing, covering all HTTP routes, CORS, error handling
- **Runtime Accuracy**: Tests run in actual Bun environment matching production container
- **Performance**: ~25ms execution time for complete routing test suite

### Phase 2: Client Layer Testing (Enhanced)

**Objective**: Comprehensive testing of all client classes with mocked HTTP responses

**Current Status**: Already working well, needs enhancement for better coverage

**Enhancements Needed**:
- Increase test coverage to 95%+ for all client classes
- Add comprehensive error mapping tests
- Test streaming operations with mocked SSE responses
- Validate session management across all clients
- Test abort signal handling and timeouts

**Enhanced Test Areas**:
```
src/__tests__/unit/
├── clients/
│   ├── command-client.test.ts    # Enhanced with streaming tests
│   ├── file-client.test.ts       # Enhanced with binary file tests
│   ├── process-client.test.ts    # Enhanced with process lifecycle tests
│   ├── port-client.test.ts       # Enhanced with URL validation tests
│   ├── git-client.test.ts        # Enhanced with repository tests
│   └── utility-client.test.ts    # Enhanced with health check tests
├── base-client.test.ts           # Enhanced with session/error handling
├── error-mapping.test.ts         # Enhanced with all error types
└── sse-parser.test.ts           # Enhanced with malformed stream tests
```

### Phase 3: Integration Testing (Reimagined)

**Objective**: Test client ↔ container communication without real containers

**Approach**: Mock Service Worker (MSW) or custom HTTP mocking
- Mock container HTTP endpoints to return realistic responses
- Test complete client workflows against mocked container
- Validate request/response formats match between layers
- Test error propagation from container to client

**Benefits**:
- No Docker dependency
- Deterministic responses
- Fast execution
- Easy to test edge cases and error conditions
- Complete workflow validation

**Test Structure**:
```
src/__tests__/integration-mocked/
├── command-workflow.test.ts      # Mock container, test command execution flow
├── file-workflow.test.ts         # Mock container, test file operation flow
├── process-workflow.test.ts      # Mock container, test process management flow
├── port-workflow.test.ts         # Mock container, test port exposure flow
├── git-workflow.test.ts          # Mock container, test git operation flow
├── session-workflow.test.ts      # Mock container, test session management
├── error-propagation.test.ts     # Mock container errors, test client handling
└── streaming-workflow.test.ts    # Mock SSE streams, test client parsing
```

**Implementation Details**:
- Use MSW to intercept HTTP requests from clients
- Create realistic mock responses based on container handler analysis
- Test both success and error scenarios
- Validate that client error mapping works correctly
- Test streaming operations with mock SSE responses

### Phase 4: E2E Testing (Simplified)

**Objective**: Single comprehensive test validating entire stack works

**Approach**: One "golden path" test with real infrastructure
- Minimal test that exercises key functionality end-to-end
- Run in dedicated environment with Docker available
- Focus on deployment validation rather than comprehensive testing
- Manual execution or specialized CI environment

**Test Coverage**:
- Basic command execution
- File operations
- Process management
- Port exposure
- Error handling

**Benefits**:
- Validates real system integration
- Catches deployment issues
- Minimal maintenance burden
- No complex resource management

## Implementation Plan

### Step 1: Container Unit Tests (1-2 days) ✅ **IN PROGRESS**
1. ✅ **COMPLETED**: Create standalone Bun server test runner (`ContainerTestServer`)
2. 🔄 **IN PROGRESS**: Implement HTTP endpoint tests for all handlers
   - ✅ **COMPLETED**: Basic routing and HTTP method validation (15/15 tests passing)
   - 🔄 **NEXT**: Handler-specific tests (exec, file, process, port, git)
3. Mock file system and process operations
4. Validate error response formats
5. Achieve 90%+ coverage of container logic

**Key Decisions Made**:
- **Hybrid Approach**: Bun test for container logic + Vitest for client/integration tests
- **Runtime Matching**: Tests run in Bun environment matching production containers
- **Performance Focus**: 25ms test execution vs. 30-60s with problematic container tests

### Step 2: Enhanced Client Tests (1 day)
1. Expand existing client unit tests
2. Add comprehensive error mapping tests
3. Test streaming and abort handling
4. Achieve 95%+ coverage of client logic

### Step 3: Mocked Integration Tests (1-2 days)
1. Set up MSW or custom HTTP mocking
2. Create realistic mock responses
3. Test complete client workflows
4. Validate error propagation
5. Test streaming operations

### Step 4: Migration from Problematic Tests (1-2 days)
1. **Analyze existing container tests** (`src/__tests__/container/`) for valuable test scenarios
2. **Extract reusable logic**:
   - Test cases from `communication.test.ts` → migrate to mocked integration tests
   - Error validation from `error-responses.test.ts` → migrate to container unit tests
   - Handler logic from `handlers.test.ts` → migrate to container unit tests
3. **Preserve test coverage** by mapping each existing test to new test structure:
   - Container HTTP endpoint tests → container unit tests
   - Client-container communication → mocked integration tests
   - Error propagation flows → both layers as appropriate
4. **Remove problematic test files** completely after migration:
   - Delete `src/__tests__/container/` directory
   - Update vitest config files to remove container-specific configuration
   - Remove container test scripts from package.json
5. **Update CI configuration** to use new test structure
6. **Verify no regression** in test coverage or scenarios

### Step 5: Simplified E2E Test (0.5 days)
1. Create single comprehensive E2E test
2. Set up manual or specialized CI execution
3. Document deployment validation requirements

## Expected Outcomes

### Coverage Improvements
- **Container Logic**: 0% → 90%+ (currently untested)
- **Client Logic**: 85% → 95%+ (enhanced testing)
- **Integration Flows**: Flaky → 100%+ (reliable mocking)
- **Overall System**: More comprehensive and reliable

### Performance Improvements
- **Container Tests**: 0 seconds → 5-10 seconds (new, fast)
- **Client Tests**: 2-5 seconds (unchanged)
- **Integration Tests**: 10-30 seconds → 5-10 seconds (mocked)
- **E2E Tests**: 45-90 seconds → 30-60 seconds (simplified)

### Reliability Improvements
- **No Docker Dependencies**: For 95% of tests
- **No Resource Management Issues**: Proper cleanup guaranteed
- **No Framework Conflicts**: Independent layer testing
- **Deterministic Results**: Mocked responses eliminate flakiness

### Maintenance Benefits
- **Faster Development Feedback**: Quick test execution
- **Easier Debugging**: Clear failure points per layer
- **Better Test Isolation**: Issues contained to specific layers
- **Reduced CI Complexity**: Fewer infrastructure requirements

## Migration Strategy

### Immediate Actions (Week 1)
1. Implement container unit tests
2. Enhance client unit tests
3. Create mocked integration tests
4. **Migrate and remove** problematic container tests (no dead code)

### Medium-term Actions (Week 2-3)
1. Refine test coverage and reliability
2. Update documentation and CI
3. Train team on new testing approach
4. Monitor test execution and stability
5. **Verify complete migration** - ensure no test scenarios were lost

### Long-term Actions (Month 1+)
1. Evaluate need for real container tests when framework improves
2. Consider integration with improved vitest-pool-workers versions
3. Expand E2E testing if needed
4. Continuous improvement based on team feedback

## Test Migration Mapping

To ensure no test scenarios are lost during migration, here's how existing problematic tests will be preserved:

### From `src/__tests__/container/communication.test.ts`:
- **Client-Container Integration scenarios** → `src/__tests__/integration-mocked/command-workflow.test.ts`
- **Session Management flows** → `src/__tests__/integration-mocked/session-workflow.test.ts` 
- **Error Propagation tests** → `src/__tests__/integration-mocked/error-propagation.test.ts`
- **Streaming Operations** → `src/__tests__/integration-mocked/streaming-workflow.test.ts`

### From `src/__tests__/container/error-responses.test.ts`:
- **HTTP Error Response validation** → `src/__tests__/container-unit/error-responses.test.ts`
- **Error code mapping** → `src/__tests__/container-unit/handlers/*.test.ts`
- **Status code consistency** → `src/__tests__/container-unit/routing.test.ts`

### From `src/__tests__/container/handlers.test.ts`:
- **HTTP Endpoint testing** → `src/__tests__/container-unit/handlers/*.test.ts`
- **CORS handling** → `src/__tests__/container-unit/cors-headers.test.ts`
- **Request/Response formats** → `src/__tests__/container-unit/handlers/*.test.ts`

### Configuration Files to Clean Up:
- Remove `vitest.container.config.ts`
- Remove `global-setup.ts` (container build setup)
- Update `package.json` scripts (remove `test:container`, `cleanup:containers`)
- Update main `vitest.config.ts` to remove container-specific settings

## Conclusion

This approach provides comprehensive test coverage while avoiding the fundamental limitations of the current vitest + workers + containers combination. By testing each layer independently and using lightweight mocking for integration validation, we achieve better coverage, faster execution, and more reliable results.

**The strategy completely eliminates dead code** by migrating all valuable test scenarios to the new architecture, ensuring no regression in test coverage while solving the framework compatibility issues. Every existing test scenario will be preserved in a more reliable and maintainable form.

---

## 📊 Implementation Progress Tracking

### ✅ **Completed Work (Phase 1 - Container Testing Foundation)**
- **Hybrid Testing Strategy**: Successfully implemented Bun test for container logic + Vitest for client/integration
- **Container Test Server**: `ContainerTestServer` class providing isolated HTTP endpoint testing
- **Routing Validation**: Complete HTTP routing test suite (15/15 tests passing in ~25ms)
- **Error Response Accuracy**: Fixed test assertions to match actual container error responses:
  - Process endpoints return `{ process: null }` with 404 status
  - Port endpoints return `{ error: "Port not exposed: X", code: "PORT_NOT_EXPOSED" }` with 404 status
- **Runtime Matching**: Tests run in actual Bun environment matching production containers
- **Performance Validation**: ~25ms execution vs 30-60s with problematic Docker-based tests

### 🔄 **Current Progress (Step 1 - Container Unit Tests)** 
- **Container Handler Tests**: Ready to implement individual handler tests (exec, file, process, port, git)
- **File Structure**: `src/__tests__/container-unit/` directory created with test infrastructure
- **Todo Status**: 1/8 major tasks completed, 1/8 in progress

### 📋 **Next Steps**
1. **Immediate**: Implement handler-specific unit tests with proper mocking
2. **Phase 2**: Create Vitest-based mocked integration tests  
3. **Migration**: Migrate existing problematic test scenarios to new architecture
4. **Cleanup**: Remove problematic container test configurations entirely

### 🎯 **Key Achievements**
- **Framework Compatibility Issues Solved**: No more vitest + workers + containers conflicts
- **Zero Dead Code Approach**: Migration-based rather than disabling problematic tests
- **True Runtime Testing**: Container logic tested in actual Bun environment
- **Dramatic Performance Improvement**: 100x+ faster execution than problematic tests

## 🚨 **Critical Testing Gap: SDK Contract Validation**

During container refactoring, we discovered **breaking changes to SDK streaming contracts** that were not caught by existing tests:

### **The Problem**
- **Container handlers** changed SSE event formats during refactoring
- **SDK interfaces** (`ExecEvent`, `LogEvent`) expect specific event structures  
- **No automated validation** exists to catch contract breaks between SDK and container layers
- **Example applications** broke silently - streaming appeared to work but events had wrong format

### **Specific Contract Breaks Found**
1. **Command Streaming (`ExecEvent`)**:
   - Container sent: `{type: "output", stream: "stdout", data: "..."}`
   - SDK expected: `{type: "stdout", data: "..."}`

2. **Process Log Streaming (`LogEvent`)**:
   - Container sent: `{type: "output", stream: "stderr", data: "..."}`
   - SDK expected: `{type: "stderr", data: "...", processId: "..."}`

### **Why Existing Tests Missed This**
- **Unit tests** mock container responses, so wrong formats weren't detected
- **Integration tests** test internal APIs, not public SDK interfaces
- **Container tests** validate HTTP endpoints but not SDK contract compliance
- **E2E tests** don't validate specific event formats, just that "streaming works"

### **Contract Testing Requirements for Future Implementation**

When implementing the new testing architecture, we need **dedicated contract validation**:

#### **1. SDK Interface Contract Tests**
```typescript
// Validate that parseSSEStream<ExecEvent>() receives correct format
describe('SDK Streaming Contracts', () => {
  it('should validate ExecEvent format from container', async () => {
    // Test actual container SSE output matches ExecEvent interface
    const containerResponse = await fetch('/api/execute/stream', {...});
    for await (const event of parseSSEStream<ExecEvent>(containerResponse.body)) {
      expect(['start', 'stdout', 'stderr', 'complete', 'error']).toContain(event.type);
      // Validate other required fields...
    }
  });
});
```

#### **2. Container-SDK Boundary Tests**
```typescript
// Validate container handlers emit SDK-compliant formats
describe('Container Handler Contracts', () => {
  it('should emit ExecEvent-compliant SSE format', async () => {
    const response = await containerTestServer.post('/api/execute/stream', {
      command: 'echo test'
    });
    const events = parseSSEFromResponse(response);
    // Validate each event matches ExecEvent interface exactly
  });
});
```

#### **3. Type-Level Contract Enforcement**
```typescript
// Compile-time validation that prevents contract changes
type ContainerExecEvent = {
  type: 'start' | 'stdout' | 'stderr' | 'complete' | 'error';
  timestamp: string;
  data?: string;
  // ... exact ExecEvent fields
};

// This should cause TypeScript error if contracts diverge
const contractCheck: ExecEvent = {} as ContainerExecEvent;
```

#### **4. Example Application Integration Tests**
```typescript
// Validate that SDK works with real consumer patterns
describe('Consumer Pattern Validation', () => {
  it('should work with example app streaming pattern', async () => {
    // Test the exact usage from examples/basic/src/endpoints/executeStream.ts
    const stream = await sandbox.execStream(command, { sessionId });
    for await (const event of parseSSEStream<ExecEvent>(stream)) {
      // Should work without mapping or compatibility layers
    }
  });
});
```

### **Integration with New Testing Architecture**

#### **Phase 1: Container Unit Tests Enhancement**
- Add contract validation to container handler tests
- Ensure emitted SSE events match SDK interface schemas
- Test format compliance, not just HTTP functionality

#### **Phase 2: Client Layer Testing Enhancement** 
- Add tests that validate `parseSSEStream()` works with actual container formats
- Test error handling when formats don't match expectations
- Validate type guards and runtime validation

#### **Phase 3: Integration Testing Enhancement**
- Mock responses must use **exact container formats**, not idealized formats
- Test SDK interface consumption with realistic container data
- Validate that no compatibility layers are needed

#### **Phase 4: Contract-First Development**
- Define contracts in shared schema files
- Generate TypeScript interfaces from schemas
- Validate container responses against schemas at build time
- Prevent deployment if contracts are broken

### **Lessons Learned**
1. **SDK interfaces are external contracts** - breaking them affects all consumers
2. **Internal refactoring can break external contracts** without proper validation
3. **Mock-heavy testing can hide real integration issues** - need some real data flow tests
4. **Contract tests should run in CI** and block merges if contracts break
5. **Consumer applications should be tested** as part of SDK validation

### **Action Items for Contract Testing**
- [ ] Add contract validation to container unit test phase
- [ ] Create SDK interface compliance tests in integration test phase  
- [ ] Add consumer pattern validation tests
- [ ] Set up contract-breaking detection in CI
- [ ] Document all public SDK contracts clearly
- [ ] Create tooling to validate container responses match SDK expectations

**Priority**: High - Contract breaks are silent and affect all SDK consumers