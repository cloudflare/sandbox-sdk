import { describe, it, expect, beforeEach } from 'vitest';
import { getSandbox, Sandbox } from '../../sandbox';

/**
 * Basic integration test for Durable Object functionality
 * Tests the core Sandbox class without container dependencies
 */
describe('Basic Durable Object Integration', () => {
  describe('Sandbox Durable Object', () => {
    it('should create and initialize sandbox instance', async () => {
      // This is a basic test to verify the Durable Object can be instantiated
      // Without the full container runtime
      
      // Note: This test validates the basic structure is correct
      // Full container integration will be tested separately once containers are properly configured
      expect(Sandbox).toBeDefined();
      expect(getSandbox).toBeDefined();
      expect(typeof getSandbox).toBe('function');
    });

    it('should validate basic exports are available', async () => {
      // Verify core exports exist
      const { Sandbox, getSandbox } = await import('../../sandbox');
      const { SandboxClient } = await import('../../clients/sandbox-client');
      
      expect(Sandbox).toBeDefined();
      expect(getSandbox).toBeDefined();
      expect(SandboxClient).toBeDefined();
    });

    it('should validate client architecture exports', async () => {
      // Test that all client classes can be imported
      const {
        CommandClient,
        FileClient,
        ProcessClient,
        PortClient,
        GitClient,
        UtilityClient
      } = await import('../../clients');

      expect(CommandClient).toBeDefined();
      expect(FileClient).toBeDefined();
      expect(ProcessClient).toBeDefined();
      expect(PortClient).toBeDefined();
      expect(GitClient).toBeDefined();
      expect(UtilityClient).toBeDefined();
    });

    it('should validate error classes are available', async () => {
      // Test error class imports
      const {
        SandboxError,
        FileNotFoundError,
        CommandNotFoundError,
        ProcessNotFoundError,
        PortAlreadyExposedError
      } = await import('../../errors');

      expect(SandboxError).toBeDefined();
      expect(FileNotFoundError).toBeDefined();
      expect(CommandNotFoundError).toBeDefined();
      expect(ProcessNotFoundError).toBeDefined();
      expect(PortAlreadyExposedError).toBeDefined();
    });

    it('should create SandboxClient without errors', async () => {
      const { SandboxClient } = await import('../../clients/sandbox-client');
      
      // Basic client creation test
      const client = new SandboxClient({
        baseUrl: 'http://test-basic.com',
        port: 3000
      });

      expect(client).toBeDefined();
      expect(client.commands).toBeDefined();
      expect(client.files).toBeDefined();
      expect(client.processes).toBeDefined();
      expect(client.ports).toBeDefined();
      expect(client.git).toBeDefined();
      expect(client.utils).toBeDefined();
    });

    it('should handle client session management', async () => {
      const { SandboxClient } = await import('../../clients/sandbox-client');
      
      const client = new SandboxClient();
      
      // Test session ID management
      expect(client.getSessionId()).toBeNull();
      
      client.setSessionId('test-session-123');
      expect(client.getSessionId()).toBe('test-session-123');
      
      client.setSessionId(null);
      expect(client.getSessionId()).toBeNull();
    });
  });

  describe('Module Structure Validation', () => {
    it('should export all expected types and classes from index', async () => {
      // Import everything from the main index
      const mainExports = await import('../../index');
      
      // Verify main classes
      expect(mainExports.Sandbox).toBeDefined();
      expect(mainExports.getSandbox).toBeDefined();
      expect(mainExports.SandboxClient).toBeDefined();
      
      // Verify domain clients
      expect(mainExports.CommandClient).toBeDefined();
      expect(mainExports.FileClient).toBeDefined();
      expect(mainExports.ProcessClient).toBeDefined();
      expect(mainExports.PortClient).toBeDefined();
      expect(mainExports.GitClient).toBeDefined();
      expect(mainExports.UtilityClient).toBeDefined();
      
      // Verify utilities
      expect(mainExports.parseSSEStream).toBeDefined();
      expect(mainExports.proxyToSandbox).toBeDefined();
    });

    it('should have consistent TypeScript types', async () => {
      // This test validates the module can be imported without TypeScript errors
      const { SandboxClient } = await import('../../index');
      
      const client = new SandboxClient({
        baseUrl: 'http://type-test.com',
        port: 3000,
        onError: (error: string, command?: string) => {
          console.log('Error callback:', error, command);
        },
        onCommandComplete: (success: boolean, exitCode: number, stdout: string, stderr: string, command: string) => {
          console.log('Command complete:', { success, exitCode, command });
        }
      });

      expect(client).toBeDefined();
      expect(typeof client.setSessionId).toBe('function');
      expect(typeof client.getSessionId).toBe('function');
      expect(typeof client.ping).toBe('function');
      expect(typeof client.getInfo).toBe('function');
    });
  });
});