// build.js — generates dist/index.html from an Are.na channel.
// Run: node --env-file=.env build.js

import { readFile, writeFile, mkdir } from "node:fs/promises";

const CHANNEL = "website-pulls";
const PER = 100;
const PAGE_DELAY = 300;
const UA = "pauloreyes.com build script (node; +https://pauloreyes.com)";
const TEMPLATE = new URL("./template.html", import.meta.url);
const OUT_DIR = new URL("./dist/", import.meta.url);
const OUT_FILE = new URL("./index.html", OUT_DIR);

// Everything from here to the end of the template is progressive-loading and
// interaction code. The build must not touch a byte of it.
const TAIL_ANCHOR = 'const log = document.getElementById("log");';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

async function fetchPage(page) {
  const url = `https://api.are.na/v3/channels/${CHANNEL}/contents?page=${page}&per=${PER}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.ARENA_TOKEN}`,
      "User-Agent": UA,
      Accept: "application/json"
    }
  });

  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`Are.na ${res.status} ${res.statusText} for ${url}\n${body}`);
  }

  return res.json();
}

async function fetchAll() {
  const blocks = [];
  let page = 1;

  for (;;) {
    const json = await fetchPage(page);
    blocks.push(...(json.data ?? []));
    if (!json.meta?.has_more_pages) break;
    page += 1;
    await sleep(PAGE_DELAY);
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Only http(s) survives; anything else is dropped rather than emitted.
function safeUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? esc(trimmed) : null;
}

// Minimal inline markdown, applied to already-escaped text.
function inline(t) {
  return t
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) =>
      /^https?:\/\//i.test(href) ? `<a href="${href}">${label}</a>` : m)
    // Are.na highlight syntax. Kept on one line so it cannot span paragraphs.
    .replace(/==([^\n]+?)==/g, "<mark>$1</mark>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_]/g, "$1<em>$2</em>");
}

// Markdown -> one or more <p class="note"> paragraphs.
function mdToHtml(md) {
  if (typeof md !== "string" || !md.trim()) return null;
  return md
    .trim()
    .split(/\n{2,}/)
    .map((para) => {
      const clean = para.replace(/^[ \t]*>[ \t]?/gm, "").trim();
      return `<p class="note">${inline(esc(clean)).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function fileSize(bytes) {
  if (typeof bytes !== "number" || !isFinite(bytes)) return null;
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

function thumb(block) {
  const small = block.image?.small;
  const src = safeUrl(small?.src);
  if (!src) return null;
  return {
    src,
    src_2x: safeUrl(small.src_2x),
    width: small.width ?? null,
    height: small.height ?? null
  };
}

function mapBlock(block, n) {
  const provider = block.source?.provider?.name ?? null;
  const sourceUrl = safeUrl(block.source?.url);
  const title = block.title ? esc(block.title) : null;

  const rec = {
    n,
    id: block.id,
    type: block.type,
    kind: String(block.type ?? "block").toLowerCase(),
    date: String(block.connection?.connected_at ?? "").slice(0, 10),
    title,
    url: sourceUrl,
    provider: provider ? esc(provider) : null,
    note: null,
    image: null,
    alt: null,
    file: null
  };

  switch (block.type) {
    case "Text":
      rec.note = mdToHtml(block.content?.markdown);
      break;

    case "Link":
    case "Embed":
      rec.note = mdToHtml(block.description?.markdown);
      break;

    case "Image":
      rec.image = thumb(block);
      rec.alt = esc(block.image?.alt_text ?? block.title ?? "");
      rec.note = mdToHtml(block.description?.markdown);
      break;

    case "Attachment": {
      rec.url = safeUrl(block.attachment?.url) ?? sourceUrl;
      rec.image = thumb(block);
      rec.alt = esc(block.image?.alt_text ?? block.title ?? "");
      rec.note = mdToHtml(block.description?.markdown);
      const ext = block.attachment?.file_extension;
      const size = fileSize(block.attachment?.file_size);
      const parts = [ext ? esc(String(ext).toUpperCase()) : null, size].filter(Boolean);
      rec.file = parts.length ? parts.join(" &middot; ") : null;
      break;
    }

    // Unknown types keep the generic heading/note/source shape above.
    default:
      rec.note = mdToHtml(block.description?.markdown ?? block.content?.markdown);
      break;
  }

  return rec;
}

// ---------------------------------------------------------------------------
// generated page code
// ---------------------------------------------------------------------------

// Replaces the demo comment, the SEED array and the loop that repeated it.
function blocksLiteral(records) {
  return `// Generated by build.js from the Are.na channel "${CHANNEL}".\n` +
    "// Do not edit by hand — re-run `node --env-file=.env build.js`.\n" +
    `const BLOCKS = ${JSON.stringify(records)};\n`;
}

// Replaces the demo rowHTML, which keyed off base_class/dims and used b.id for
// the accession number. Signature, name and gutter markup are unchanged, so
// appendNext and the deep-link handler keep working against it untouched.
function rowHtmlSource() {
  return `function rowHTML(b) {
  var acc = String(b.n).padStart(4, "0");
  var title = b.title || "";
  var heading = b.url
    ? '<a href="' + b.url + '" rel="noopener">' + (title || b.url) + '</a>'
    : (title || "Untitled");
  var note = b.note || "";
  var body;

  if (b.type === "Text") {
    body = note + (b.provider ? '<span class="src">&mdash; ' + b.provider + '</span>' : "");
  } else if (b.type === "Image") {
    // Index mode hides the plate and caption, so a note is the only thing that
    // would render. Fall back to a label only when there is none.
    body = plate(b) + (note || '<span class="idx-label">[image]</span>') +
      (title ? '<span class="caption">' + title + '</span>' : "");
  } else if (b.type === "Attachment") {
    // The heading always renders in index mode, so the row is never empty and
    // no fallback label is needed.
    body = '<h2 class="title">' + heading + '</h2>' + plate(b) + note +
      (b.file ? '<span class="caption">' + b.file + '</span>' : "");
  } else {
    // Link, Embed, and any type this build does not know about.
    body = '<h2 class="title">' + heading + '</h2>' + note +
      (b.provider ? '<span class="src">' + b.provider + '</span>' : "");
  }

  return '<article class="entry" id="e' + acc + '">' +
    '<div class="gutter"><a class="acc" href="#e' + acc + '">' + acc + '</a></div>' +
    '<div class="body">' + body + '</div>' +
  '</article>';
}

function plate(b) {
  if (!b.image || !b.image.src) return "";
  var i = b.image;
  return '<img class="plate" src="' + i.src + '"' +
    (i.src_2x ? ' srcset="' + i.src + ' 1x, ' + i.src_2x + ' 2x"' : "") +
    (i.width ? ' width="' + i.width + '"' : "") +
    (i.height ? ' height="' + i.height + '"' : "") +
    ' loading="lazy" alt="' + (b.alt || "") + '">';
}
`;
}

const PLATE_CSS = `
  .plate {
    display: block;
    width: auto;
    max-width: 380px;
    height: auto;
    border: 1px solid var(--rule);
    background-color: var(--hatch);
  }
`;

// ---------------------------------------------------------------------------
// template patching
// ---------------------------------------------------------------------------

// Every edit goes through here, so a template change that moves an anchor
// fails the build instead of silently emitting a broken page.
function replaceOnce(html, re, replacement, what) {
  const all = new RegExp(re.source, re.flags.replace("g", "") + "g");
  const hits = html.match(all);
  if (!hits) throw new Error(`template.html: could not find ${what}`);
  if (hits.length > 1) throw new Error(`template.html: ${what} matched ${hits.length} times, expected 1`);
  // Function replacement so $-sequences in the data are never interpreted.
  return html.replace(re, () => replacement);
}

function patchTemplate(template, records) {
  const tailAt = template.indexOf(TAIL_ANCHOR);
  if (tailAt === -1) throw new Error(`template.html: missing tail anchor \`${TAIL_ANCHOR}\``);
  if (template.indexOf(TAIL_ANCHOR, tailAt + 1) !== -1) {
    throw new Error(`template.html: tail anchor \`${TAIL_ANCHOR}\` is not unique`);
  }
  const tail = template.slice(tailAt);

  let html = template;

  // 1. Placeholder .plate styling -> real <img> styling, border kept.
  html = replaceOnce(
    html,
    /\n  \.plate \{[\s\S]*?\n  \}\n\n  \.plate span \{[\s\S]*?\n  \}\n/,
    PLATE_CSS,
    "the .plate / .plate span CSS blocks"
  );

  // 2. Demo comment + SEED array -> real data, bound directly to BLOCKS.
  html = replaceOnce(
    html,
    /\/\/ -{10,}\n\/\/ Sample data,[\s\S]*?\n\/\/ -{10,}\nconst SEED = \[[\s\S]*?\n\];\n/,
    blocksLiteral(records),
    "the demo comment + SEED array literal"
  );

  // 3. Drop the loop that repeated SEED to 96 entries.
  html = replaceOnce(
    html,
    /\n\/\/ Repeat the seed[\s\S]*?\nconst TOTAL = \d+;\nconst BLOCKS = \[\];\nfor \(let i = 0; i < TOTAL; i\+\+\) \{\n[\s\S]*?\n\}\n/,
    "",
    "the SEED repeat loop"
  );

  // 4. Demo KIND map -> unused by the real renderer.
  html = replaceOnce(html, /const KIND = \{[^}]*\};\n/, "", "the KIND map");

  // 5. Demo rowHTML -> real field map. Bounded by the tail anchor so nothing
  //    below it (appendNext, observer, deep link, toggles, clock) is touched.
  const fnAt = html.indexOf("function rowHTML(b) {");
  const stopAt = html.indexOf(TAIL_ANCHOR);
  if (fnAt === -1) throw new Error("template.html: could not find rowHTML");
  if (stopAt === -1 || stopAt < fnAt) throw new Error("template.html: rowHTML is not above the tail anchor");
  html = html.slice(0, fnAt) + rowHtmlSource() + "\n" + html.slice(stopAt);

  // --- post-conditions -----------------------------------------------------

  if (!html.endsWith(tail)) {
    throw new Error("build: the progressive-loading tail was modified — refusing to write");
  }

  const banned = ["SEED", "TOTAL", "base_class", "b.dims", "KIND["];
  for (const token of banned) {
    if (html.includes(token)) throw new Error(`build: \`${token}\` survived patching`);
  }

  const required = [
    '<div id="sentinel"></div>',
    '<div class="end" id="end" hidden>End of log</div>',
    '<div class="foot">',
    "function appendNext() {",
    "new IntersectionObserver(",
    "observer.observe(sentinel);",
    "while (!document.querySelector(location.hash) && appendNext())",
    'document.getElementById("theme")',
    'document.getElementById("density")',
    "setInterval(tick, 20000);"
  ];
  for (const snippet of required) {
    if (!html.includes(snippet)) throw new Error(`build: required markup/code missing — ${snippet}`);
  }

  return html;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

if (!process.env.ARENA_TOKEN) {
  throw new Error("ARENA_TOKEN is not set — run with `node --env-file=.env build.js`");
}

const raw = await fetchAll();

const kept = raw.filter((b) => b.base_type === "Block" && b.state === "available");

// Oldest first so accession numbers follow when each block was saved.
kept.sort((a, b) => {
  const at = String(a.connection?.connected_at ?? "");
  const bt = String(b.connection?.connected_at ?? "");
  if (at !== bt) return at < bt ? -1 : 1;
  return (a.connection?.position ?? 0) - (b.connection?.position ?? 0);
});

const records = kept.map((b, i) => mapBlock(b, i + 1)).reverse();

const template = await readFile(TEMPLATE, "utf8");
const html = patchTemplate(template, records);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, html);

const counts = {};
for (const r of records) counts[r.type] = (counts[r.type] ?? 0) + 1;

console.log(`fetched  ${raw.length} blocks, kept ${records.length}`);
for (const [type, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(12)} ${n}`);
}
console.log(`written  ${OUT_FILE.pathname}`);
