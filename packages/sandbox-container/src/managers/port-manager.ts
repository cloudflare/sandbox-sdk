/**
 * PortManager - Pure Business Logic for Port Operations
 *
 * Handles port operation logic without any I/O dependencies.
 * Extracted from PortService to enable fast unit testing.
 *
 * Responsibilities:
 * - URL path parsing for proxy requests
 * - Date calculations for cleanup thresholds
 * - PortInfo object creation
 * - Error code determination
 *
 * NO I/O operations - all infrastructure delegated to fetch and PortStore
 */

import type { PortInfo } from '../core/types';

export interface ProxyPathInfo {
  targetPath: string;
  targetUrl: string;
}

/**
 * PortManager contains pure business logic for port operations.
 * No fetch APIs, no timers, no I/O - just pure functions that can be unit tested instantly.
 */
export class PortManager {
  /**
   * Calculate the cleanup threshold date (1 hour ago)
   */
  calculateCleanupThreshold(): Date {
    return new Date(Date.now() - 60 * 60 * 1000);
  }

  /**
   * Parse proxy request URL to extract target path
   * Input: http://example.com/proxy/8080/api/test?param=value
   * Output: { targetPath: 'api/test', targetUrl: 'http://localhost:8080/api/test?param=value' }
   */
  parseProxyPath(requestUrl: string, port: number): ProxyPathInfo {
    const url = new URL(requestUrl);
    const pathSegments = url.pathname.split('/');

    // Remove the /proxy/{port} part to get the actual path
    const targetPath = pathSegments.slice(3).join('/');
    const targetUrl = `http://localhost:${port}/${targetPath}${url.search}`;

    return {
      targetPath,
      targetUrl,
    };
  }

  /**
   * Create a PortInfo object with current timestamp
   */
  createPortInfo(port: number, name?: string): PortInfo {
    return {
      port,
      name,
      exposedAt: new Date(),
      status: 'active',
    };
  }

  /**
   * Create an updated PortInfo with inactive status
   */
  createInactivePortInfo(existingInfo: PortInfo): PortInfo {
    return {
      ...existingInfo,
      status: 'inactive',
    };
  }

  /**
   * Determine appropriate error code based on operation and error type
   */
  determineErrorCode(operation: string, error: Error | string): string {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const lowerMessage = errorMessage.toLowerCase();

    // Common error patterns
    if (lowerMessage.includes('not found') || lowerMessage.includes('enoent')) {
      return 'PORT_NOT_FOUND';
    }

    if (lowerMessage.includes('already exposed') || lowerMessage.includes('conflict')) {
      return 'PORT_ALREADY_EXPOSED';
    }

    if (lowerMessage.includes('connection refused') || lowerMessage.includes('econnrefused')) {
      return 'CONNECTION_REFUSED';
    }

    if (lowerMessage.includes('timeout') || lowerMessage.includes('etimedout')) {
      return 'CONNECTION_TIMEOUT';
    }

    // Operation-specific defaults
    switch (operation) {
      case 'expose':
        return 'PORT_EXPOSE_ERROR';
      case 'unexpose':
        return 'PORT_UNEXPOSE_ERROR';
      case 'list':
        return 'PORT_LIST_ERROR';
      case 'get':
        return 'PORT_GET_ERROR';
      case 'proxy':
        return 'PROXY_ERROR';
      case 'update':
        return 'PORT_UPDATE_ERROR';
      case 'cleanup':
        return 'PORT_CLEANUP_ERROR';
      default:
        return 'PORT_OPERATION_ERROR';
    }
  }

  /**
   * Create a standardized error message for port operations
   */
  createErrorMessage(operation: string, port: number, error: string): string {
    const operationVerbs: Record<string, string> = {
      expose: 'expose',
      unexpose: 'unexpose',
      list: 'list',
      get: 'get info for',
      proxy: 'proxy request to',
      update: 'update',
      cleanup: 'cleanup',
    };

    const verb = operationVerbs[operation] || 'operate on';
    return `Failed to ${verb} port ${port}: ${error}`;
  }

  /**
   * Validate port number is within valid range
   */
  isValidPortRange(port: number): boolean {
    return port >= 1 && port <= 65535;
  }

  /**
   * Format port list for logging
   */
  formatPortList(ports: Array<{ port: number; info: PortInfo }>): string {
    return ports
      .map(({ port, info }) => `${port} (${info.name || 'unnamed'}, ${info.status})`)
      .join(', ');
  }

  /**
   * Determine if a port should be cleaned up based on age and status
   */
  shouldCleanupPort(portInfo: PortInfo, threshold: Date): boolean {
    return portInfo.status === 'inactive' && portInfo.exposedAt < threshold;
  }
}
