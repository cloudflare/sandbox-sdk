import type { GlobalSetupContext } from 'vitest/node';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

/**
 * Global Setup for Container Tests
 * 
 * This runs in Node.js environment and handles:
 * 1. Reading wrangler.jsonc configuration
 * 2. Detecting if containers are defined
 * 3. Building container images with consistent build IDs
 * 4. Providing build information to the Workers runtime via provide/inject
 */

interface WranglerConfig {
  containers?: Array<{
    class_name: string;
    image: string;
    name: string;
    max_instances?: number;
  }>;
}

function generateBuildId(): string {
  return Math.random().toString(36).substring(2, 10).toLowerCase();
}

function hasContainers(): boolean {
  try {
    const wranglerConfig = readFileSync('./wrangler.jsonc', 'utf-8');
    // More robust JSONC comment removal
    const cleanConfig = wranglerConfig
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove /* */ comments
      .replace(/\/\/.*$/gm, '')         // Remove // comments
      .replace(/,\s*}/g, '}')           // Remove trailing commas before }
      .replace(/,\s*]/g, ']');          // Remove trailing commas before ]
    
    const config: WranglerConfig = JSON.parse(cleanConfig);
    return Array.isArray(config.containers) && config.containers.length > 0;
  } catch (error) {
    console.warn('[Global Setup] Could not read wrangler.jsonc:', error);
    return false;
  }
}

function buildContainerImage(buildId: string): void {
  const imageTag = `cloudflare-dev/sandbox:${buildId}`;
  
  try {
    // Use docker build directly to avoid registry prefix issues
    execSync(`docker build . -t ${imageTag}`, {
      stdio: 'inherit',
      cwd: process.cwd()
    });
  } catch (error) {
    console.error(`[Global Setup] Failed to build container image:`, error);
    throw new Error(`Container image build failed: ${error}`);
  }
}

export default function globalSetup({ provide }: GlobalSetupContext) {
  if (hasContainers()) {
    const buildId = generateBuildId();
    
    buildContainerImage(buildId);
    
    // Provide the build ID to tests
    provide('containerBuildId', buildId);
    provide('containerReady', true);
  } else {
    provide('containerBuildId', 'no-containers');
    provide('containerReady', false);
  }

  // Cleanup function (optional)
  return () => {
    // Cleanup complete
  };
}