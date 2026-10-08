// Deploys and checks the examples against this repository's package and shim instead of the
// published ones their manifests name.
//
//   node tools/example.ts deploy <example> [--name <worker>] [--main <path>] [-- <wrangler args>]
//   node tools/example.ts check-bundles [<example>...]
//
// <example> is a folder under examples/, such as workspace or coding-agents/pi.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(root, "examples");
const packageDir = join(root, "packages/sandbox");
const packageEntry = join(packageDir, "dist/index.mjs");
const localShimImage = "sandbox-tools:local";

const wranglerConfig = z.looseObject({
  containers: z
    .array(
      z.looseObject({
        images: z.record(z.string(), z.looseObject({ dockerfile: z.string() })).optional(),
      }),
    )
    .optional(),
});

const metafile = z.object({ inputs: z.record(z.string(), z.looseObject({})) });

function run(command: string, args: string[]): void {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
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

// Writes a config beside the original, so its relative paths keep their meaning. It bundles the
// package from packages/sandbox/dist. To deploy, an example that copies the shim builds its image
// from the local donor image. To bundle only, the config drops its containers, so no image builds.
function writeLocalConfig(
  dir: string,
  purpose: "deploy" | "bundle",
  name: string | undefined,
  main: string | undefined,
): string {
  const source = join(dir, "wrangler.jsonc");
  const parsed = ts.parseConfigFileTextToJson(source, readFileSync(source, "utf8"));
  if (parsed.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  }
  const config = wranglerConfig.parse(parsed.config);
  config.alias = { "@cloudflare/sandbox": relative(dir, packageEntry) };
  if (purpose === "bundle") {
    delete config.containers;
  } else if (usesShim(dir)) {
    for (const container of config.containers ?? []) {
      for (const image of Object.values(container.images ?? {})) {
        image.build_vars = { SANDBOX_TOOLS_IMAGE: localShimImage };
      }
    }
  }
  if (name !== undefined) config.name = name;
  if (main !== undefined) config.main = main;
  const target = join(dir, "wrangler.local.json");
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return target;
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
  if (usesShim(dir)) run("npm", ["run", "shim:build"]);
  const config = writeLocalConfig(dir, "deploy", name, main);
  try {
    run("npx", ["wrangler", "deploy", "--config", config, ...wranglerArgs]);
  } finally {
    rmSync(config, { force: true });
  }
}

// Bundles each example without deploying it and fails unless the package came from
// packages/sandbox/dist. Run `vp pack` first.
function checkBundles(examples: string[]): void {
  if (!existsSync(packageEntry)) throw new Error("Run `npx vp pack` first");
  const outdir = mkdtempSync(join(tmpdir(), "sandbox-example-bundle-"));
  try {
    for (const example of examples.length > 0 ? examples : allExamples()) {
      const dir = exampleDir(example);
      const config = writeLocalConfig(dir, "bundle", undefined, undefined);
      const meta = join(outdir, `${example.replaceAll("/", "-")}.json`);
      try {
        run("npx", [
          "wrangler",
          "deploy",
          "--dry-run",
          "--config",
          config,
          "--outdir",
          join(outdir, example),
          "--metafile",
          meta,
        ]);
      } finally {
        rmSync(config, { force: true });
      }
      // Wrangler bundles from the config's folder, so input paths are relative to it.
      const inputs = Object.keys(metafile.parse(JSON.parse(readFileSync(meta, "utf8"))).inputs).map(
        (input) => resolve(dir, input),
      );
      const stray = inputs.filter(
        (input) =>
          (input.startsWith(packageDir) && input !== packageEntry) ||
          input.includes("/node_modules/@cloudflare/sandbox/"),
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

const [command, ...rest] = process.argv.slice(2);
if (command === "deploy") deploy(rest);
else if (command === "check-bundles") checkBundles(rest);
else
  throw new Error("Usage: node tools/example.ts deploy <example> | check-bundles [<example>...]");
