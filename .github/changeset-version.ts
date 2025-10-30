import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import fg from 'fast-glob';

// This script is used by the `release.yml` workflow to update the version of the packages being released.
// The standard step is only to run `changeset version` but this does not update the package-lock.json file.
// So we also run `npm install`, which does this update.
// This is a workaround until this is handled automatically by `changeset version`.
// See https://github.com/changesets/changesets/issues/421.
execSync('npx changeset version', {
  stdio: 'inherit'
});
execSync('npm install', {
  stdio: 'inherit'
});

// Update all version references across the codebase after changeset updates package.json
try {
  const packageJson = JSON.parse(
    fs.readFileSync('./packages/sandbox/package.json', 'utf-8')
  );
  const newVersion = packageJson.version;

  console.log(
    `\n🔍 Searching for version references to update to ${newVersion}...\n`
  );

  // Patterns to match version references in different contexts
  const versionPatterns = [
    // SDK version constant
    {
      pattern: /export const SDK_VERSION = '[\d.]+';/g,
      replacement: `export const SDK_VERSION = '${newVersion}';`,
      description: 'SDK version constant in version.ts'
    },
    // Docker image versions (production and test)
    {
      pattern: /FROM docker\.io\/cloudflare\/sandbox:[\d.]+/g,
      replacement: `FROM docker.io/cloudflare/sandbox:${newVersion}`,
      description: 'Production Docker image'
    },
    {
      pattern: /# FROM docker\.io\/cloudflare\/sandbox:[\d.]+/g,
      replacement: `# FROM docker.io/cloudflare/sandbox:${newVersion}`,
      description: 'Commented production Docker image'
    },
    {
      pattern: /FROM cloudflare\/sandbox-test:[\d.]+/g,
      replacement: `FROM cloudflare/sandbox-test:${newVersion}`,
      description: 'Test Docker image'
    },
    {
      pattern: /docker\.io\/cloudflare\/sandbox-test:[\d.]+/g,
      replacement: `docker.io/cloudflare/sandbox-test:${newVersion}`,
      description: 'Test Docker image (docker.io)'
    },
    // Image tags in docker commands
    {
      pattern: /cloudflare\/sandbox:[\d.]+/g,
      replacement: `cloudflare/sandbox:${newVersion}`,
      description: 'Docker image reference'
    },
    {
      pattern: /cloudflare\/sandbox-test:[\d.]+/g,
      replacement: `cloudflare/sandbox-test:${newVersion}`,
      description: 'Test Docker image reference'
    },
    // Example package.json dependencies
    {
      pattern: /"@cloudflare\/sandbox":\s*"\^[\d.]+"/g,
      replacement: `"@cloudflare/sandbox": "^${newVersion}"`,
      description: 'Example package.json @cloudflare/sandbox dependencies'
    }
  ];

  // Files to search and update
  const filePatterns = [
    '**/*.md', // All markdown files
    '**/Dockerfile', // All Dockerfiles
    '**/Dockerfile.*', // Dockerfile variants
    '**/*.ts', // TypeScript files (for documentation comments)
    '**/*.js', // JavaScript files
    '**/*.json', // JSON configs (but not package.json/package-lock.json)
    '**/*.yaml', // YAML configs
    '**/*.yml', // YML configs
    'examples/**/package.json' // Example package.json files (exception to ignore rule below)
  ];

  // Ignore patterns
  const ignorePatterns = [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/package.json', // Don't modify package.json (changeset does this)
    '**/package-lock.json', // Don't modify package-lock.json (npm install does this)
    '**/.github/changeset-version.ts' // Don't modify this script itself
  ];

  // Find all matching files
  const files = await fg(filePatterns, {
    ignore: ignorePatterns,
    onlyFiles: true
  });

  console.log(`📁 Found ${files.length} files to check\n`);

  let updatedFilesCount = 0;
  let totalReplacementsCount = 0;

  for (const file of files) {
    let content = fs.readFileSync(file, 'utf-8');
    let fileModified = false;
    let fileReplacementsCount = 0;

    // Try all patterns on this file
    for (const { pattern, replacement, description } of versionPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        content = content.replace(pattern, replacement);
        fileModified = true;
        fileReplacementsCount += matches.length;
      }
    }

    if (fileModified) {
      fs.writeFileSync(file, content);
      updatedFilesCount++;
      totalReplacementsCount += fileReplacementsCount;
      console.log(
        `  ✅ ${file} (${fileReplacementsCount} replacement${
          fileReplacementsCount > 1 ? 's' : ''
        })`
      );
    }
  }

  console.log(
    `\n✨ Updated ${totalReplacementsCount} version reference${
      totalReplacementsCount !== 1 ? 's' : ''
    } across ${updatedFilesCount} file${updatedFilesCount !== 1 ? 's' : ''}`
  );
  console.log(`   New version: ${newVersion}\n`);
} catch (error) {
  console.error('❌ Failed to update file versions:', error);
  // Don't fail the whole release for this
}
