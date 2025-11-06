#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

/**
 * Validates changeset files to ensure they don't contain @repo/* packages.
 *
 * Usage: node scripts/validate-changesets.js <changeset-files...>
 *
 * Exit codes:
 * 0 - All changesets valid
 * 1 - Invalid changesets found
 */

const INVALID_PACKAGE_PATTERN = /@repo\//;

const HELP_MESSAGE = `
❌ Invalid changeset detected

Changesets should only include @cloudflare/sandbox, not internal packages.

Internal packages (@repo/shared, @repo/sandbox-container) are private
and should not appear in changesets. Any changes to internal packages
should be reflected through changes to @cloudflare/sandbox.

To fix:
1. Delete the invalid changeset file
2. Run: npx changeset
3. Select ONLY @cloudflare/sandbox (use spacebar to select)
4. Do NOT select @repo/shared or @repo/sandbox-container
5. Commit the new changeset
`;

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

function findInvalidPackages(frontmatter) {
  const invalidPackages = [];
  const lines = frontmatter.split('\n');

  for (const line of lines) {
    if (INVALID_PACKAGE_PATTERN.test(line)) {
      // Extract package name from line like "'@repo/shared': patch"
      const pkgMatch = line.match(/'(@repo\/[^']+)'/);
      if (pkgMatch) {
        invalidPackages.push(pkgMatch[1]);
      }
    }
  }

  return invalidPackages;
}

function validateChangesetFile(filePath) {
  const fileName = path.basename(filePath);

  // Skip non-changeset files
  if (fileName === 'README.md' || fileName === 'config.json') {
    return { valid: true, invalidPackages: [] };
  }

  // Read file content
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`Error reading file ${filePath}: ${error.message}`);
    return { valid: false, invalidPackages: [] };
  }

  // Extract frontmatter
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    // No frontmatter found, skip this file
    return { valid: true, invalidPackages: [] };
  }

  // Check for invalid packages
  const invalidPackages = findInvalidPackages(frontmatter);

  return {
    valid: invalidPackages.length === 0,
    invalidPackages
  };
}

function main() {
  const args = process.argv.slice(2);

  // Filter to only .md files
  const changesetFiles = args.filter((file) => file.endsWith('.md'));

  if (changesetFiles.length === 0) {
    // No changeset files to validate
    process.exit(0);
  }

  let hasError = false;

  for (const file of changesetFiles) {
    const result = validateChangesetFile(file);

    if (!result.valid) {
      hasError = true;
      console.error(`\n❌ Invalid changeset: ${file}`);
      console.error(`Found: ${result.invalidPackages.join(', ')}`);
      console.error(HELP_MESSAGE);
    }
  }

  if (hasError) {
    console.error('\n');
    process.exit(1);
  }

  // All valid - silent success
  process.exit(0);
}

main();
