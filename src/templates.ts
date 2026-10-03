// Thin wrapper that pulls the OpenCode plugin text asset into the bundle.
//
// esbuild maps `templates/report-finding.plugin.ts` to its text loader
// (scripts/build.mjs), so at build time the import evaluates to a string.
// Under the Node test runner the same import resolves to a normal module, so
// the asset is read from disk instead. test/template.test.ts asserts that both
// paths yield byte-identical text.
import { readFileSync } from "node:fs";
import templateText from "../templates/report-finding.plugin.ts";

const moduleValue: unknown = templateText;

export const reportFindingTemplate: string =
  typeof moduleValue === "string"
    ? moduleValue
    : readFileSync(new URL("../templates/report-finding.plugin.ts", import.meta.url), "utf8");
