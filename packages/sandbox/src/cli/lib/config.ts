/**
 * Configuration management for the Sandbox CLI
 *
 * Uses env-paths for cross-platform config directories (XDG spec on Linux)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Paths {
  config: string;
  data: string;
}

export interface Config {
  accountId?: string;
  apiToken?: string;
  defaultWorkerName?: string;
}

export interface ApiKeyEntry {
  name: string;
  keyHash: string; // SHA-256 hash of the key
  createdAt: string;
  lastUsed?: string;
}

export interface WorkerConfig {
  name: string;
  accountId: string;
  createdAt: string;
  containers: ContainerConfig[];
  apiKeys: ApiKeyEntry[];
}

export interface ContainerConfig {
  name: string;
  image: string;
  binding: string;
  isDefault?: boolean;
}

let cachedPaths: Paths | null = null;

export async function getPaths(): Promise<Paths> {
  if (cachedPaths) return cachedPaths;

  const { default: envPaths } = await import('env-paths');
  const paths = envPaths('cloudflare-sandbox');
  cachedPaths = { config: paths.config, data: paths.data };
  return cachedPaths;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export async function getConfig(): Promise<Config> {
  const paths = await getPaths();
  const configFile = join(paths.config, 'config.json');

  if (!existsSync(configFile)) {
    return {};
  }

  try {
    const content = readFileSync(configFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const paths = await getPaths();
  ensureDir(paths.config);
  const configFile = join(paths.config, 'config.json');
  writeFileSync(configFile, JSON.stringify(config, null, 2));
}

export async function getWorkerConfig(
  name: string
): Promise<WorkerConfig | null> {
  const paths = await getPaths();
  const workerFile = join(paths.data, 'workers', `${name}.json`);

  if (!existsSync(workerFile)) {
    return null;
  }

  try {
    const content = readFileSync(workerFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function saveWorkerConfig(config: WorkerConfig): Promise<void> {
  const paths = await getPaths();
  const workersDir = join(paths.data, 'workers');
  ensureDir(workersDir);
  const workerFile = join(workersDir, `${config.name}.json`);
  writeFileSync(workerFile, JSON.stringify(config, null, 2));
}

export async function deleteWorkerConfig(name: string): Promise<void> {
  const paths = await getPaths();
  const workerFile = join(paths.data, 'workers', `${name}.json`);

  if (existsSync(workerFile)) {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(workerFile);
  }
}

export async function listWorkerConfigs(): Promise<WorkerConfig[]> {
  const paths = await getPaths();
  const workersDir = join(paths.data, 'workers');

  if (!existsSync(workersDir)) {
    return [];
  }

  const { readdirSync } = await import('node:fs');
  const files = readdirSync(workersDir).filter((f) => f.endsWith('.json'));
  const configs: WorkerConfig[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(workersDir, file), 'utf-8');
      configs.push(JSON.parse(content));
    } catch {
      // Skip invalid files
    }
  }

  return configs;
}
