import { execSync } from "node:child_process";
import * as fs from "node:fs";

// This script is used by the `release.yml` workflow to update the version of the packages being released.
// The standard step is only to run `changeset version` but this does not update the package-lock.json file.
// So we also run `npm install`, which does this update.
// This is a workaround until this is handled automatically by `changeset version`.
// See https://github.com/changesets/changesets/issues/421.
execSync("npx changeset version", {
  stdio: "inherit",
});
execSync("npm install", {
  stdio: "inherit",
});

// Update Dockerfile and README version references after changeset updates package.json
try {
  const packageJson = JSON.parse(fs.readFileSync("./packages/sandbox/package.json", "utf-8"));
  const newVersion = packageJson.version;

  const dockerfilePath = "./examples/basic/Dockerfile";
  let dockerfileContent = fs.readFileSync(dockerfilePath, "utf-8");

  // Update the production image version in the comment
  dockerfileContent = dockerfileContent.replace(
    /# FROM docker\.io\/cloudflare\/sandbox:[\d.]+/,
    `# FROM docker.io/cloudflare/sandbox:${newVersion}`
  );

  // Update the test image version
  dockerfileContent = dockerfileContent.replace(
    /FROM cloudflare\/sandbox-test:[\d.]+/,
    `FROM cloudflare/sandbox-test:${newVersion}`
  );

  fs.writeFileSync(dockerfilePath, dockerfileContent);
  console.log(`✅ Updated Dockerfile versions to ${newVersion}`);

  // Update README.md
  const readmePath = "./README.md";
  let readmeContent = fs.readFileSync(readmePath, "utf-8");

  // Update the Docker image version in README
  readmeContent = readmeContent.replace(
    /FROM docker\.io\/cloudflare\/sandbox:[\d.]+/,
    `FROM docker.io/cloudflare/sandbox:${newVersion}`
  );

  fs.writeFileSync(readmePath, readmeContent);
  console.log(`✅ Updated README.md version to ${newVersion}`);

} catch (error) {
  console.error("❌ Failed to update file versions:", error);
  // Don't fail the whole release for this
}
