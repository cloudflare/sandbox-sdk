import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Sandbox } from '../../sandbox';
import { parseSSEStream } from '../../sse-parser';

/**
 * End-to-End Streaming Operations Tests
 * 
 * These tests validate real-time streaming functionality:
 * 1. Command execution streaming with live output
 * 2. Process log streaming for monitoring
 * 3. Long-running command streaming with progress updates
 * 4. Error handling in streaming scenarios
 * 
 * Tests demonstrate how streaming operations work in practice
 * with real commands and realistic timing scenarios.
 */
describe('Streaming Operations E2E', () => {
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

  describe('Command Execution Streaming', () => {
    it('should stream output from long-running commands in real-time', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Create a script that produces output over time
        const progressScript = `
#!/bin/bash
echo "Starting E2E streaming test..."
for i in {1..5}; do
    echo "Progress update $i/5: Processing..."
    sleep 1
    echo "Step $i completed at $(date)"
done
echo "Final result: E2E streaming test completed successfully!"
        `.trim();

        await instance.client.files.writeFile('/tmp/progress.sh', progressScript);
        await instance.client.commands.execute('chmod +x /tmp/progress.sh');
        
        // Execute the script with streaming
        const stream = await instance.client.commands.executeStream('bash /tmp/progress.sh');
        
        // Collect streaming events
        const events = [];
        const startTime = Date.now();
        
        for await (const event of parseSSEStream(stream)) {
          events.push({
            ...event,
            receivedAt: Date.now() - startTime
          });
          
          // Break on completion to avoid infinite loop
          if (event.type === 'complete' || events.length > 50) {
            break;
          }
        }
        
        return { events };
      });

      // Validate streaming behavior
      expect(result.events.length).toBeGreaterThan(5);
      
      // Should have start event
      const startEvents = result.events.filter(e => e.type === 'start');
      expect(startEvents).toHaveLength(1);
      
      // Should have multiple stdout events
      const stdoutEvents = result.events.filter(e => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThan(5);
      
      // Should have completion event
      const completeEvents = result.events.filter(e => e.type === 'complete');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].exitCode).toBe(0);
      
      // Validate content appears in stdout
      const allOutput = stdoutEvents.map(e => e.data).join('');
      expect(allOutput).toContain('Starting E2E streaming test');
      expect(allOutput).toContain('Progress update 1/5');
      expect(allOutput).toContain('Progress update 5/5');
      expect(allOutput).toContain('E2E streaming test completed successfully');
      
      // Validate timing - events should be spread over time
      const timeSpan = Math.max(...result.events.map(e => e.receivedAt)) - Math.min(...result.events.map(e => e.receivedAt));
      expect(timeSpan).toBeGreaterThan(4000); // Should take at least 4 seconds due to sleeps
    }, 120000);

    it('should handle streaming commands with both stdout and stderr', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Create a script that outputs to both stdout and stderr
        const mixedOutputScript = `
#!/bin/bash
echo "stdout: Starting mixed output test"
echo "stderr: This is an error message" >&2
echo "stdout: Processing step 1"
echo "stderr: Warning in step 1" >&2
sleep 1
echo "stdout: Processing step 2"
echo "stderr: Warning in step 2" >&2
echo "stdout: Mixed output test completed"
exit 0
        `.trim();

        await instance.client.files.writeFile('/tmp/mixed.sh', mixedOutputScript);
        await instance.client.commands.execute('chmod +x /tmp/mixed.sh');
        
        // Stream the mixed output command
        const stream = await instance.client.commands.executeStream('bash /tmp/mixed.sh');
        
        const events = [];
        for await (const event of parseSSEStream(stream)) {
          events.push(event);
          if (event.type === 'complete' || events.length > 30) {
            break;
          }
        }
        
        return { events };
      });

      // Validate mixed output streaming
      const stdoutEvents = result.events.filter(e => e.type === 'stdout');
      const stderrEvents = result.events.filter(e => e.type === 'stderr');
      const completeEvents = result.events.filter(e => e.type === 'complete');
      
      expect(stdoutEvents.length).toBeGreaterThan(2);
      expect(stderrEvents.length).toBeGreaterThan(2);
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].exitCode).toBe(0);
      
      // Validate stdout content
      const stdoutContent = stdoutEvents.map(e => e.data).join('');
      expect(stdoutContent).toContain('stdout: Starting mixed output test');
      expect(stdoutContent).toContain('stdout: Processing step 1');
      expect(stdoutContent).toContain('stdout: Mixed output test completed');
      
      // Validate stderr content
      const stderrContent = stderrEvents.map(e => e.data).join('');
      expect(stderrContent).toContain('stderr: This is an error message');
      expect(stderrContent).toContain('stderr: Warning in step 1');
      expect(stderrContent).toContain('stderr: Warning in step 2');
    }, 120000);

    it('should stream real-time compilation output', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Create a simple C program to compile
        const cProgram = `
#include <stdio.h>
#include <unistd.h>

int main() {
    printf("Compilation successful!\\n");
    printf("Running E2E compiled program...\\n");
    
    for (int i = 1; i <= 3; i++) {
        printf("Iteration %d: Hello from compiled C program\\n", i);
        fflush(stdout);
        sleep(1);
    }
    
    printf("C program execution completed\\n");
    return 0;
}
        `.trim();

        await instance.client.files.writeFile('/tmp/program.c', cProgram);
        
        // Check if gcc is available
        const gccCheck = await instance.client.commands.execute('which gcc');
        if (!gccCheck.success) {
          // Skip if gcc not available
          throw new Error('GCC not available - skipping compilation test');
        }
        
        // Stream the compilation and execution
        const compileAndRunScript = `
echo "Starting compilation..."
gcc -o /tmp/program /tmp/program.c -v 2>&1 || echo "Compilation failed"
echo "Compilation phase completed"
echo "Running compiled program..."
/tmp/program 2>&1 || echo "Execution failed"
echo "Process completed"
        `.trim();

        await instance.client.files.writeFile('/tmp/compile_run.sh', compileAndRunScript);
        await instance.client.commands.execute('chmod +x /tmp/compile_run.sh');
        
        const stream = await instance.client.commands.executeStream('bash /tmp/compile_run.sh');
        
        const events = [];
        for await (const event of parseSSEStream(stream)) {
          events.push(event);
          if (event.type === 'complete' || events.length > 100) {
            break;
          }
        }
        
        return { events, hasGcc: true };
      });

      if (!result.hasGcc) {
        console.log('Skipping compilation test - GCC not available');
        return;
      }

      // Validate compilation streaming
      const stdoutEvents = result.events.filter(e => e.type === 'stdout');
      const completeEvents = result.events.filter(e => e.type === 'complete');
      
      expect(stdoutEvents.length).toBeGreaterThan(3);
      expect(completeEvents).toHaveLength(1);
      
      const output = stdoutEvents.map(e => e.data).join('');
      expect(output).toContain('Starting compilation');
      expect(output).toContain('Running compiled program');
      expect(output).toContain('Hello from compiled C program');
      expect(output).toContain('Process completed');
    }, 120000);
  });

  describe('Process Log Streaming', () => {
    it('should stream logs from long-running background processes', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Create a long-running process that generates logs
        const loggerScript = `
#!/bin/bash
echo "Logger started at $(date)"
for i in {1..8}; do
    echo "Log entry $i: $(date) - Processing data batch $i"
    sleep 0.5
done
echo "Logger finished at $(date)"
        `.trim();

        await instance.client.files.writeFile('/tmp/logger.sh', loggerScript);
        await instance.client.commands.execute('chmod +x /tmp/logger.sh');
        
        // Start the logger as a background process
        const process = await instance.client.processes.startProcess('bash /tmp/logger.sh');
        
        // Give it a moment to start
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Stream the process logs
        const logStream = await instance.client.processes.streamProcessLogs(process.id);
        
        const logEvents = [];
        for await (const event of parseSSEStream(logStream)) {
          logEvents.push(event);
          
          // Stop when we see completion or have enough events
          if (event.type === 'complete' || 
              (event.type === 'stdout' && event.data.includes('Logger finished')) ||
              logEvents.length > 50) {
            break;
          }
        }
        
        // Get final process status
        const finalStatus = await instance.client.processes.getProcess(process.id);
        
        return { 
          process,
          logEvents,
          finalStatus
        };
      });

      // Validate process was started
      expect(result.process.status).toBe('running');
      expect(result.process.command).toBe('bash /tmp/logger.sh');
      
      // Validate log streaming
      expect(result.logEvents.length).toBeGreaterThan(5);
      
      const stdoutEvents = result.logEvents.filter(e => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThan(5);
      
      // Validate log content
      const logOutput = stdoutEvents.map(e => e.data).join('');
      expect(logOutput).toContain('Logger started at');
      expect(logOutput).toContain('Log entry 1:');
      expect(logOutput).toContain('Log entry 8:');
      expect(logOutput).toContain('Processing data batch');
      expect(logOutput).toContain('Logger finished at');
      
      // Validate process completion
      expect(['running', 'completed'].includes(result.finalStatus.status)).toBe(true);
    }, 120000);
  });

  describe('Streaming Error Scenarios', () => {
    it('should handle streaming command failures gracefully', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Create a script that fails partway through
        const failingScript = `
#!/bin/bash
echo "Starting process that will fail..."
echo "Step 1: Success"
sleep 1
echo "Step 2: Success"
sleep 1
echo "Step 3: About to fail..."
echo "Error: Something went wrong!" >&2
exit 1
        `.trim();

        await instance.client.files.writeFile('/tmp/failing.sh', failingScript);
        await instance.client.commands.execute('chmod +x /tmp/failing.sh');
        
        // Stream the failing command
        const stream = await instance.client.commands.executeStream('bash /tmp/failing.sh');
        
        const events = [];
        for await (const event of parseSSEStream(stream)) {
          events.push(event);
          if (event.type === 'complete' || events.length > 30) {
            break;
          }
        }
        
        return { events };
      });

      // Validate failure was streamed properly
      const stdoutEvents = result.events.filter(e => e.type === 'stdout');
      const stderrEvents = result.events.filter(e => e.type === 'stderr');
      const completeEvents = result.events.filter(e => e.type === 'complete');
      
      expect(stdoutEvents.length).toBeGreaterThan(2);
      expect(stderrEvents.length).toBeGreaterThan(0);
      expect(completeEvents).toHaveLength(1);
      
      // Validate failure details
      expect(completeEvents[0].exitCode).toBe(1);
      expect(completeEvents[0].success).toBe(false);
      
      // Validate output content
      const stdoutContent = stdoutEvents.map(e => e.data).join('');
      const stderrContent = stderrEvents.map(e => e.data).join('');
      
      expect(stdoutContent).toContain('Starting process that will fail');
      expect(stdoutContent).toContain('Step 1: Success');
      expect(stdoutContent).toContain('About to fail');
      expect(stderrContent).toContain('Error: Something went wrong!');
    }, 120000);

    it('should handle streaming timeout scenarios', async () => {
      const result = await runInDurableObject(sandboxStub, async (instance: Sandbox) => {
        await waitForContainerReady(instance);
        
        // Create a script that runs longer than we'll wait for it
        const longRunningScript = `
#!/bin/bash
echo "Starting very long process..."
for i in {1..100}; do
    echo "Long operation step $i"
    sleep 1
done
echo "This should not be reached in our test"
        `.trim();

        await instance.client.files.writeFile('/tmp/long.sh', longRunningScript);
        await instance.client.commands.execute('chmod +x /tmp/long.sh');
        
        // Stream with limited collection time
        const stream = await instance.client.commands.executeStream('bash /tmp/long.sh');
        
        const events = [];
        const startTime = Date.now();
        const maxWaitTime = 5000; // 5 seconds max
        
        for await (const event of parseSSEStream(stream)) {
          events.push(event);
          
          // Stop collecting after max time or completion
          if (Date.now() - startTime > maxWaitTime || 
              event.type === 'complete' || 
              events.length > 20) {
            break;
          }
        }
        
        const totalTime = Date.now() - startTime;
        
        return { 
          events, 
          totalTime,
          eventCount: events.length
        };
      });

      // Validate partial streaming collection
      expect(result.events.length).toBeGreaterThan(2);
      expect(result.totalTime).toBeLessThan(10000); // Should have stopped collection
      
      const stdoutEvents = result.events.filter(e => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThan(1);
      
      // Should have initial output
      const output = stdoutEvents.map(e => e.data).join('');
      expect(output).toContain('Starting very long process');
      expect(output).toContain('Long operation step');
      
      // Should NOT have reached the final message
      expect(output).not.toContain('This should not be reached');
    }, 120000);
  });
});