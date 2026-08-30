# pauloreyes.net

Static site generated from a private Are.na channel (`website-pulls`) — a research
log of saved blocks. Deployed on Netlify at pauloreyes.net.
Repo: `pauloreyes-vsnry/pauloreyeswebsite`.

## Build

```bash
node --env-file=.env build.js
```

Reads `template.html`, fetches the channel, writes `dist/index.html` and
`dist/feed.xml`. Needs `ARENA_TOKEN` in `.env`. (`inspect.mjs` and `variants.mjs` are throwaway scripts
for eyeballing the API response.)

**Zero dependencies, and it stays that way.** No package.json, no framework, no
bundler — Node 24, ESM, standard library. If something looks like it needs a
library, it doesn't.

`build.js` patches the template through anchored replacements that throw when an
anchor moves, and asserts the progressive-loading code (from
`const log = document.getElementById("log");` to EOF) survives byte-identical.
Those guards catch template drift — don't route around them.

The RSS feed is hand-rolled XML built from the raw blocks (not the page records,
which are already HTML-escaped — feeding those through would double-escape).
It is checked for well-formedness before it is written.

## Are.na v3 field gotchas

Verified against the live API. Don't guess or substitute.

- Blocks are in `data`, not `contents`
- Block type is `type`, not `base_class`
- Text bodies are `content.markdown`; Link and Embed use `description.markdown`
- Order by `connection.connected_at`, never `created_at`. Accession numbers record
  when a block was saved and must stay stable
- Keep only `base_type === "Block"` and `state === "available"`
- Never emit `embed.html`. No third-party iframes — Embeds render as links

## Design constraints

- No grid, no animation or transitions
- No accent colour, with one exception: bio links hover blue
  (`--link-hover`, a separate value per theme). Scoped to `.bio` and wrapped in
  `@media (hover: hover)` — the research log stays monochrome
- Three IBM Plex faces carry block type: Sans (UI), Mono (metadata), Serif (notes)
- Images capped at 380px wide
- Two modes (Read / Index) times two themes (light / dark). Changes must hold in
  all four

## Workflow

1. Edit `template.html`
2. `node --env-file=.env build.js`
3. Open `dist/index.html` and check it
4. `git status --short` — **always, before committing**
5. Commit and push

Netlify deploys on push. `dist/` is gitignored, so Netlify runs the build itself;
the build command and `ARENA_TOKEN` live in the Netlify dashboard, not the repo
(there is no netlify.toml).

New Are.na blocks publish without a code change:
`.github/workflows/rebuild.yml` pings a Netlify build hook at 13:00 UTC on
Mondays and Thursdays.

**Deploys are metered — don't push casually.** Netlify bills credits: 15 per
production deploy, 300/month on the free plan, hard cap with no auto-recharge.
That is 20 deploys a month, total. The twice-weekly rebuild spends ~9, leaving
~11 for code pushes. A daily rebuild would blow the allowance on its own.

So batch edits into one commit rather than pushing each small change, and prefer
checking `dist/index.html` locally over deploying to look at it.
