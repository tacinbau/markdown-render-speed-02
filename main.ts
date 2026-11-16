// FastMark driver: renders every case in MAKEFUN_INPUT_DIR/cases.json with
// the local parse() and writes the HTML strings, in order, to
// MAKEFUN_OUTPUT_DIR/html.json. Run as `node main.ts` (Node 22/24
// type-stripping; only erasable syntax is used here).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// A short warmup so the real cases hit already-optimized parser code:
// the harness runs one cold process, and the first parse pays the JIT cost.
// Keep it small (a few ms) but representative: heading, emphasis, link,
// code span, list and a table row exercise the hot paths.
parse('# FastMark\n\nA *warmup* paragraph with a [link](https://example.com), `code`, **strong** and ~~struck~~ text.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');

const raw = readFileSync(join(inDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw);

const rendered = [];
for (const c of cases) rendered.push(parse(c.markdown));

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(rendered));
