// Versions @cloudflare/sandbox from changesets and prints release notes. See docs/releasing.md.
//
//   node tools/release.ts pending          Prints true when a changeset releases the package
//   node tools/release.ts version          Applies the pending changesets
//   node tools/release.ts notes <version>  Prints the CHANGELOG.md section for <version>
import { readChangesets } from "@changesets/read";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = join(root, "packages/sandbox/package.json");
const changelog = join(root, "packages/sandbox/CHANGELOG.md");
const crateManifest = join(root, "crates/sandbox-tools/Cargo.toml");
const cargoLock = join(root, "Cargo.lock");

function run(command: string, args: string[]): void {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

function packageVersion(): string {
  return z.object({ version: z.string() }).parse(JSON.parse(readFileSync(packageManifest, "utf8")))
    .version;
}

function replaceOnce(path: string, pattern: RegExp, replacement: string): void {
  const contents = readFileSync(path, "utf8");
  if (!pattern.test(contents)) throw new Error(`${path} does not match ${pattern}`);
  writeFileSync(path, contents.replace(pattern, replacement));
}

// An empty changeset, from `changeset --empty`, releases nothing.
async function pending(): Promise<void> {
  const changesets = await readChangesets(root);
  const releasing = changesets.some((changeset) => changeset.releases.length > 0);
  process.stdout.write(`${releasing}\n`);
}

// Bumps the package, writes its CHANGELOG.md entry, and deletes the changesets it used. The shim
// ships in the donor image of the same version, so its crate takes that version too.
function version(): void {
  run("npx", ["changeset", "version"]);
  const next = packageVersion();
  replaceOnce(crateManifest, /^version = ".*"$/m, `version = "${next}"`);
  replaceOnce(
    cargoLock,
    /(\[\[package\]\]\nname = "sandbox-tools"\nversion = )".*"/,
    `$1"${next}"`,
  );
  run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);
  run("npx", ["vp", "fmt", changelog]);
}

// A section runs from its "## <version>" heading to the next second-level heading.
function notes(release: string): void {
  const lines = readFileSync(changelog, "utf8").split("\n");
  const start = lines.indexOf(`## ${release}`);
  if (start === -1) throw new Error(`${changelog} has no section for ${release}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const section = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
  if (section === "") throw new Error(`${changelog} has an empty section for ${release}`);
  process.stdout.write(`${section}\n`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "pending" && rest.length === 0) await pending();
else if (command === "version" && rest.length === 0) version();
else if (command === "notes" && rest.length === 1) notes(rest[0]);
else {
  console.error("Usage: node tools/release.ts pending | version | notes <version>");
  process.exit(1);
}
