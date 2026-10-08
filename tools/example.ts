// Deploys, checks, and versions the examples. Each example is a template that pins a published
// package version and copies the shim from the donor image of the same version. Inside this
// repository, `deploy` replaces both with this repository's package build and shim.
//
//   node tools/example.ts deploy <example> [--name <worker>] [--main <path>] [-- <wrangler args>]
//   node tools/example.ts check-bundles [<example>...]
//   node tools/example.ts check-standalone [<example>...]
//   node tools/example.ts check-versions
//   node tools/example.ts set-version <version>
//   node tools/example.ts sync-runner [--check]
//
// <example> is a folder under examples/, such as workspace or coding-agents/pi.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(root, "examples");
const packageDir = join(root, "packages/sandbox");
const packageEntry = join(packageDir, "dist/index.mjs");
const packageName = "@cloudflare/sandbox";
const localShimImage = "sandbox-tools:local";
const donorImage = "docker.io/cloudflare/sandbox";
const donorArg = /^ARG SANDBOX_TOOLS_IMAGE=(.*)$/m;
const exactVersion = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const stableVersion = /^\d+\.\d+\.\d+$/;

// Each coding agent carries a copy of the runner modules, so a copy of its folder deploys alone.
const runnerSource = "examples/coding-agents/runner";
const runnerDir = join(root, runnerSource);
const runnerCopyDir = "src/runner";

const wranglerConfig = z.looseObject({
  containers: z
    .array(
      z.looseObject({
        images: z.record(z.string(), z.looseObject({ dockerfile: z.string() })).optional(),
      }),
    )
    .optional(),
});
type WranglerConfig = z.infer<typeof wranglerConfig>;

const examplePackage = z.looseObject({
  dependencies: z.record(z.string(), z.string()).optional(),
});

const metafile = z.object({ inputs: z.record(z.string(), z.looseObject({})) });

function run(command: string, args: string[], cwd = root): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function exampleDir(example: string): string {
  const dir = join(examplesDir, example);
  if (!existsSync(join(dir, "wrangler.jsonc"))) {
    throw new Error(`examples/${example} has no wrangler.jsonc`);
  }
  return dir;
}

function allExamples(): string[] {
  const found: string[] = [];
  for (const parent of ["", "coding-agents"]) {
    for (const entry of readdirSync(join(examplesDir, parent), { withFileTypes: true })) {
      const example = join(parent, entry.name);
      if (entry.isDirectory() && existsSync(join(examplesDir, example, "wrangler.jsonc"))) {
        found.push(example);
      }
    }
  }
  return found.sort();
}

function usesShim(dir: string): boolean {
  return readFileSync(join(dir, "Dockerfile"), "utf8").includes("SANDBOX_TOOLS_IMAGE");
}

// The package version an example pins, or undefined when it does not depend on the package.
function pinnedVersion(dir: string): string | undefined {
  const manifest = examplePackage.parse(
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
  );
  return manifest.dependencies?.[packageName];
}

// The donor image tag an example's Dockerfile defaults to, or undefined when it does not copy
// the shim.
function donorVersion(dir: string): string | undefined {
  if (!usesShim(dir)) return undefined;
  const image = readFileSync(join(dir, "Dockerfile"), "utf8").match(donorArg)?.[1];
  if (image === undefined || !image.startsWith(`${donorImage}:`)) {
    throw new Error(
      `examples/${relative(examplesDir, dir)}/Dockerfile must default SANDBOX_TOOLS_IMAGE to ${donorImage}:<version>`,
    );
  }
  return image.slice(donorImage.length + 1);
}

function readConfig(dir: string): WranglerConfig {
  const source = join(dir, "wrangler.jsonc");
  const parsed = ts.parseConfigFileTextToJson(source, readFileSync(source, "utf8"));
  if (parsed.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  }
  return wranglerConfig.parse(parsed.config);
}

// Writes the config beside the original, so its relative paths keep their meaning.
function writeLocalConfig(dir: string, config: WranglerConfig): string {
  const target = join(dir, "wrangler.local.json");
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return target;
}

// Bundles the package from packages/sandbox/dist instead of the version the example pins.
function useLocalPackage(dir: string, config: WranglerConfig): void {
  config.alias = { [packageName]: relative(dir, packageEntry) };
}

// Runs the Wrangler installed where `cwd` resolves it.
function bundle(cwd: string, config: string, outdir: string, extraArgs: string[]): void {
  run(
    "npx",
    ["wrangler", "deploy", "--dry-run", "--config", config, "--outdir", outdir, ...extraArgs],
    cwd,
  );
}

function deploy(args: string[]): void {
  const separator = args.indexOf("--");
  const own = separator === -1 ? args : args.slice(0, separator);
  const wranglerArgs = separator === -1 ? [] : args.slice(separator + 1);
  const [example, ...flags] = own;
  if (example === undefined) throw new Error("deploy needs an example, such as workspace");
  let name: string | undefined;
  let main: string | undefined;
  for (let index = 0; index < flags.length; index += 2) {
    const value = flags[index + 1];
    if (value === undefined) throw new Error(`${flags[index]} needs a value`);
    if (flags[index] === "--name") name = value;
    else if (flags[index] === "--main") main = value;
    else throw new Error(`Unknown option ${flags[index]}`);
  }

  const dir = exampleDir(example);
  run("npx", ["vp", "pack"]);
  const config = readConfig(dir);
  useLocalPackage(dir, config);
  // An example that copies the shim builds its image from the local donor image.
  if (usesShim(dir)) {
    run("npm", ["run", "shim:build"]);
    for (const container of config.containers ?? []) {
      for (const image of Object.values(container.images ?? {})) {
        image.build_vars = { SANDBOX_TOOLS_IMAGE: localShimImage };
      }
    }
  }
  if (name !== undefined) config.name = name;
  if (main !== undefined) config.main = main;
  const configPath = writeLocalConfig(dir, config);
  try {
    run("npx", ["wrangler", "deploy", "--config", configPath, ...wranglerArgs]);
  } finally {
    rmSync(configPath, { force: true });
  }
}

// Bundles each example without its containers, so no image builds, and fails unless the package
// came from packages/sandbox/dist. Run `vp pack` first.
function checkBundles(examples: string[]): void {
  if (!existsSync(packageEntry)) throw new Error("Run `npx vp pack` first");
  const outdir = mkdtempSync(join(tmpdir(), "sandbox-example-bundle-"));
  try {
    for (const example of examples.length > 0 ? examples : allExamples()) {
      const dir = exampleDir(example);
      const config = readConfig(dir);
      useLocalPackage(dir, config);
      delete config.containers;
      const configPath = writeLocalConfig(dir, config);
      const meta = join(outdir, `${example.replaceAll("/", "-")}.json`);
      try {
        bundle(root, configPath, join(outdir, example), ["--metafile", meta]);
      } finally {
        rmSync(configPath, { force: true });
      }
      // Wrangler bundles from the config's folder, so input paths are relative to it.
      const inputs = Object.keys(metafile.parse(JSON.parse(readFileSync(meta, "utf8"))).inputs).map(
        (input) => resolve(dir, input),
      );
      const stray = inputs.filter(
        (input) =>
          (input.startsWith(packageDir) && input !== packageEntry) ||
          input.includes(`/node_modules/${packageName}/`),
      );
      if (stray.length > 0) {
        throw new Error(
          `examples/${example} bundled the package from somewhere other than its local build: ${stray.join(", ")}`,
        );
      }
      console.log(`examples/${example}: bundles the local package build`);
    }
  } finally {
    rmSync(outdir, { force: true, recursive: true });
  }
}

// Copies each example's files out of the repository, as `npm create cloudflare` does, without
// what .gitignore leaves out. Then installs the copy from the registry, type-checks it, and
// bundles it without its containers.
function checkStandalone(examples: string[]): void {
  for (const example of examples.length > 0 ? examples : allExamples()) {
    const prefix = `${relative(root, exampleDir(example))}/`;
    const copy = mkdtempSync(join(tmpdir(), "sandbox-example-standalone-"));
    try {
      const listArgs = [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        prefix,
      ];
      const files = execFileSync("git", listArgs, { cwd: root, encoding: "utf8" })
        .split("\0")
        .filter((file) => file !== "");
      for (const file of files) {
        const target = join(copy, file.slice(prefix.length));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(root, file), target);
      }
      run("npm", ["install", "--no-audit", "--no-fund"], copy);
      run("npx", ["tsc", "--noEmit"], copy);
      const config = readConfig(copy);
      delete config.containers;
      bundle(copy, writeLocalConfig(copy, config), join(copy, "dist"), []);
      console.log(`examples/${example}: installs, type-checks, and bundles on its own`);
    } finally {
      rmSync(copy, { force: true, recursive: true });
    }
  }
}

// Fails unless every example pins the same exact package version, and every example that copies
// the shim defaults to the donor image of that version.
function checkVersions(): void {
  const found = new Map<string, string[]>();
  const record = (version: string, source: string) => {
    found.set(version, [...(found.get(version) ?? []), source]);
  };
  for (const example of allExamples()) {
    const dir = exampleDir(example);
    const pinned = pinnedVersion(dir);
    if (pinned !== undefined) {
      if (!exactVersion.test(pinned)) {
        throw new Error(
          `examples/${example} must pin an exact ${packageName} version, not ${pinned}`,
        );
      }
      record(pinned, `examples/${example}/package.json`);
    }
    const donor = donorVersion(dir);
    if (donor !== undefined) record(donor, `examples/${example}/Dockerfile`);
  }
  if (found.size === 0) throw new Error(`No example depends on ${packageName}`);
  if (found.size > 1) {
    const lines = [...found].map(([version, sources]) => `  ${version}: ${sources.join(", ")}`);
    throw new Error(`Examples name different versions:\n${lines.join("\n")}`);
  }
  console.log(`Examples use ${packageName} and its donor image at ${[...found.keys()].join("")}`);
}

// Points every example at a published stable version: its package pin and its donor image tag.
// Then runs `npm install` so package-lock.json records the new pins.
function setVersion(version: string | undefined): void {
  if (version === undefined || !stableVersion.test(version)) {
    throw new Error("set-version needs a stable version, such as 1.1.0");
  }
  for (const example of allExamples()) {
    const dir = exampleDir(example);
    if (pinnedVersion(dir) !== undefined) {
      const path = join(dir, "package.json");
      const manifest = examplePackage.parse(JSON.parse(readFileSync(path, "utf8")));
      manifest.dependencies = { ...manifest.dependencies, [packageName]: version };
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    if (donorVersion(dir) !== undefined) {
      const path = join(dir, "Dockerfile");
      const dockerfile = readFileSync(path, "utf8");
      writeFileSync(
        path,
        dockerfile.replace(donorArg, `ARG SANDBOX_TOOLS_IMAGE=${donorImage}:${version}`),
      );
    }
  }
  run("npm", ["install", "--no-audit", "--no-fund"]);
  checkVersions();
}

// The contents each coding agent's src/runner should have: every module of the canonical runner,
// after a first line that names its source.
function runnerCopies(): Map<string, string> {
  const copies = new Map<string, string>();
  const modules = readdirSync(runnerDir).filter((name) => name.endsWith(".ts"));
  for (const file of modules.sort()) {
    const header = `// Generated from ${runnerSource}/${file} by \`npm run example -- sync-runner\`.`;
    copies.set(file, `${header}\n${readFileSync(join(runnerDir, file), "utf8")}`);
  }
  return copies;
}

// Writes the canonical runner's modules into each coding agent's src/runner and removes any other
// file there. With --check, writes nothing and fails unless every copy is current.
function syncRunner(args: string[]): void {
  const check = args.includes("--check");
  const otherArgs = args.filter((arg) => arg !== "--check");
  if (otherArgs.length > 0) throw new Error(`Unknown option ${otherArgs.join(" ")}`);
  const copies = runnerCopies();
  const differences: string[] = [];
  for (const agent of allExamples().filter((example) => example.startsWith("coding-agents/"))) {
    const target = join(exampleDir(agent), runnerCopyDir);
    for (const [file, contents] of copies) {
      const path = join(target, file);
      const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      if (current === contents) continue;
      differences.push(`${current === undefined ? "missing" : "stale"} ${relative(root, path)}`);
      if (!check) {
        mkdirSync(target, { recursive: true });
        writeFileSync(path, contents);
        console.log(`Wrote ${relative(root, path)}`);
      }
    }
    const extras = existsSync(target)
      ? readdirSync(target).filter((file) => !copies.has(file))
      : [];
    for (const file of extras) {
      const path = join(target, file);
      differences.push(`extra ${relative(root, path)}`);
      if (!check) {
        rmSync(path, { force: true, recursive: true });
        console.log(`Removed ${relative(root, path)}`);
      }
    }
  }
  if (check && differences.length > 0) {
    throw new Error(
      `Runner copies differ from ${runnerSource}. Run \`npm run example -- sync-runner\`.\n  ${differences.join("\n  ")}`,
    );
  }
  console.log(`Coding agents carry the current runner from ${runnerSource}`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "deploy") deploy(rest);
else if (command === "check-bundles") checkBundles(rest);
else if (command === "check-standalone") checkStandalone(rest);
else if (command === "check-versions") checkVersions();
else if (command === "set-version") setVersion(rest[0]);
else if (command === "sync-runner") syncRunner(rest);
else
  throw new Error(
    "Usage: node tools/example.ts deploy <example> | check-bundles [<example>...] | check-standalone [<example>...] | check-versions | set-version <version> | sync-runner [--check]",
  );
