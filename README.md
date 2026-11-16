[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/tacinbau/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/tacinbau/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# FastMark

A faster Markdown renderer: `parse(markdown)` returns exactly the HTML
marked 18.1.3 renders with its default options (GFM on, breaks off),
byte for byte — but from a dependency-free, single-pass implementation
built for speed on a cold process.

## How it works

- **Block parser** — a line-based pass for headings, fenced and indented
  code, lists, block quotes, tables, HTML blocks, thematic breaks, setext
  headings and link reference definitions.
- **Inline renderer** — one pass over each text run that follows marked's
  own inline algorithm: links and images are consumed before code spans,
  and emphasis is resolved with marked's left/right-flanking delimiter
  runs over a masked source (code spans, link labels and HTML tags
  hidden), including its rule-of-three handling. The renderer produces
  HTML directly, without building an intermediate token array, and tracks
  the plain-text form of a run in parallel so image alt text comes from
  the same parse.

## Layout

- `parse.js` — the renderer; `export function parse(markdown)`.
- `main.ts` — the driver: reads `MAKEFUN_INPUT_DIR/cases.json`, renders
  each case alone with `parse()`, writes `MAKEFUN_OUTPUT_DIR/html.json`.
- `package.json` — `{"type": "module"}`.

## Run

```sh
node main.ts
```
