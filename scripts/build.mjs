// Build dist/index.js with esbuild and enforce the dependency boundary.
//
// The OpenCode `report_finding` plugin is a text asset: the ".plugin.ts" loader
// override embeds the raw file instead of compiling it. Metafile assertions fail
// the build if the asset is missing, if it imports anything, or if a runtime
// dependency other than Valibot (Zod, @opencode/*, Octokit, TypeSafe SDK, ...)
// leaks into the bundle.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, "dist");
const templateInput = "templates/report-finding.plugin.ts";
const forbiddenDependencies = ["@opencode/plugin", "@opencode-ai", "zod", "octokit", "typesafe"];

await mkdir(outdir, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(outdir, "index.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  metafile: true,
  write: false,
  loader: { ".plugin.ts": "text" },
});

const outputPath = "dist/index.js";
const output = result.outputFiles?.find((file) => file.path.endsWith(outputPath));
if (!output) {
  throw new Error(`Build assertion failed: ${outputPath} was not produced`);
}
await writeFile(join(root, outputPath), output.contents);
await writeFile(join(outdir, "metafile.json"), `${JSON.stringify(result.metafile, null, 2)}\n`);

const inputs = result.metafile.inputs;
const inputNames = Object.keys(inputs);

// 1. The plugin text asset is present and does not import anything by itself.
const template = inputs[templateInput];
if (!template) {
  throw new Error(`Build assertion failed: ${templateInput} is not an input`);
}
if (template.imports.length !== 0) {
  throw new Error(`Build assertion failed: ${templateInput} must not import modules`);
}

// 2. Every bundled node_modules input belongs to Valibot.
const nodeModuleInputs = inputNames.filter((name) => /(^|\/)node_modules\//.test(name));
const runtimePackages = new Set();
for (const name of nodeModuleInputs) {
  const match = name.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
  if (match) {
    runtimePackages.add(match[1]);
  }
  if (!/(^|\/)valibot\//.test(name)) {
    throw new Error(`Build assertion failed: unexpected runtime dependency input ${name}`);
  }
}

// 3. Forbidden producer/SDK packages are reported by name, not by string search,
// so occurrences inside the embedded template text stay allowed.
const forbidden = inputNames.filter((name) =>
  forbiddenDependencies.some((dependency) => name.toLowerCase().includes(dependency)),
);
if (forbidden.length > 0) {
  throw new Error(`Build assertion failed: forbidden dependency inputs ${forbidden.join(", ")}`);
}

// 4. The only external imports are Node built-ins.
for (const importPath of result.metafile.outputs[outputPath]?.imports ?? []) {
  if (importPath.external && !importPath.path.startsWith("node:")) {
    throw new Error(`Build assertion failed: ${outputPath} imports external module ${importPath.path}`);
  }
}

const rawBytes = output.contents.length;
const gzipBytes = gzipSync(output.contents).length;

console.log(`built ${outputPath}`);
console.log(`  format esm / platform node / target node24`);
console.log(`  raw ${rawBytes} bytes / gzip ${gzipBytes} bytes`);
console.log(`  inputs ${inputNames.length} files; runtime packages: ${[...runtimePackages].join(", ") || "none"}`);
console.log(`  assertions: template text asset present and import-free; node_modules inputs only valibot; external imports only node: built-ins`);
console.log(`  metafile dist/metafile.json`);
