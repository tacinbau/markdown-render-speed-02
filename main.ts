// Driver for markdown-render-speed-02: reads every case from
// MAKEFUN_INPUT_DIR/cases.json, renders each one alone with parse() from
// parse.js, and writes the HTML strings in order to
// MAKEFUN_OUTPUT_DIR/html.json. Runs on Node 22 (type-stripping) and Node 24.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { parse } from "./parse.js";

// The workload deopts constantly across 720 varied inputs, so TurboFan
// compile/deopt churn costs more than optimized code saves here.
try {
  setFlagsFromString("--no-opt");
} catch {
  // Unknown flag on some runtimes: fall back silently, never crash.
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(readFileSync(join(inputDir, "cases.json"), "utf8"));
const out = new Array(cases.length);
for (let i = 0; i < cases.length; i++) out[i] = parse(cases[i].markdown);
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(out));
