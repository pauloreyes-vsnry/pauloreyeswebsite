# pauloreyes.net

Static site generated from a private Are.na channel (`website-pulls`) — a research
log of saved blocks. Deployed on Netlify at pauloreyes.net.
Repo: `pauloreyes-vsnry/pauloreyeswebsite`.

## Build

```bash
node --env-file=.env build.js
```

Reads `template.html`, fetches the channel, writes `dist/index.html` and
`dist/feed.xml`. Needs `ARENA_TOKEN` in `.env`. (`inspect.mjs`, `variants.mjs` and `embed.mjs` are
throwaway scripts for eyeballing the API response — gitignored, local only,
so they will not be in a fresh clone.)

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

`BUILT_AT` is stamped with the build's ISO timestamp through the same anchored
replacement. It must stay **above** `const log = document.getElementById("log");`
— the tail below that line is asserted byte-identical, so a stamp inside it would
fail every build. The footer-left shows "pulled N days ago" from it by default
and toggles to the Calgary clock on click; past 14 days it wraps in `<mark>`.

## Are.na v3 field gotchas

Verified against the live API. Don't guess or substitute.

- Blocks are in `data`, not `contents`
- Block type is `type`, not `base_class`
- Text bodies are `content.markdown`; Link and Embed use `description.markdown`
- Order by `connection.connected_at`, never `created_at`. Accession numbers record
  when a block was saved and must stay stable
- Keep only `base_type === "Block"` and `state === "available"`
- Never emit `embed.html`. No third-party iframes — Embeds render as links

**Authoring convention.** In a Text block, put the attribution in its own final
paragraph starting with an em dash: `— Chuck Palahniuk`. A plain `--` works too.
The build strips it from the note and renders it as the mono `.src` line. This
matters because index mode shows only a note's first paragraph, so an
attribution left inside the body text disappears there. A typed attribution
outranks `source.provider.name`.

## Design constraints

- No grid, no animation or transitions
- No accent colour, with one exception: bio links hover blue
  (`--link-hover`, a separate value per theme). Scoped to `.bio` and wrapped in
  `@media (hover: hover)` — the research log stays monochrome
- Three IBM Plex faces carry block type: Sans (UI), Mono (metadata), Serif (notes)
- Images capped at 380px wide
- Three axes, 16 combinations, and a change must hold in all of them:
  Read/Index x light/dark x 4 hues
- Hue cycle: tapping the masthead name cycles `data-hue` neutral → red → green →
  blue → neutral, independent of `data-theme`. Neutral removes the attribute
  entirely, so the default palette is untouched. Palettes are `oklch()` with no
  sRGB fallback block — browsers map down on narrow-gamut displays. Keep the
  order stable and always pass through neutral: four taps is how a visitor gets
  back out

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
