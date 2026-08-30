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
const OUT_FEED = new URL("./feed.xml", OUT_DIR);

const SITE = "https://pauloreyes.net";
const FEED_URL = `${SITE}/feed.xml`;
const FEED_DESCRIPTION =
  "A research log \u2014 links, images and notes saved by Paulo Reyes, "
  + "published from an Are.na channel.";

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
// feed
// ---------------------------------------------------------------------------

function xmlEsc(s) {
  return String(s)
    // Control characters are not legal in XML 1.0 at all.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cdata(s) {
  const clean = String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  // Split any accidental terminator so it cannot close the section early.
  return "<![CDATA[" + clean.replace(/\]\]>/g, "]]]]><![CDATA[>") + "]]>";
}

function rawHttpUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

const RFC822_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC822_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function rfc822(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return RFC822_DAYS[d.getUTCDay()] + ", " + p(d.getUTCDate()) + " "
    + RFC822_MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear() + " "
    + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds())
    + " GMT";
}

// Markdown down to readable prose: markers dropped, link labels kept.
function mdToPlain(md) {
  if (typeof md !== "string" || !md.trim()) return "";
  return md
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/==([^\n]+?)==/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_]/g, "$1$2")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstLine(text, max) {
  const limit = max || 70;
  const line = text.split("\n").map((s) => s.trim()).find(Boolean) || "";
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "") + "…";
}

// Filenames that carry no meaning for a reader.
const OPAQUE_STEM = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{8,}$/i,
  /^(img|dsc|dscf|pxl|photo|image|screen[ _-]?shot)[ _-]?\d+/i,
  /^[0-9][0-9._-]*$/
];

function feedTitle(block, acc) {
  const title = (block.title || "").trim();
  if (block.type === "Image") {
    const m = title.match(/^(.*)\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?|bmp|svg)$/i);
    const stem = m ? m[1] : title;
    if (!title || OPAQUE_STEM.some((re) => re.test(stem))) return "Image " + acc;
    return title;
  }
  if (title) return title;
  const plain = mdToPlain(block.type === "Text"
    ? block.content?.markdown
    : block.description?.markdown);
  if (plain) return firstLine(plain);
  return (block.type || "Block") + " " + acc;
}

// Built from the raw blocks, not the page records, so text is escaped exactly
// once — the page records already carry HTML escaping.
function mapFeedItem(block, n) {
  const acc = String(n).padStart(4, "0");
  const permalink = SITE + "/#e" + acc;
  return {
    title: feedTitle(block, acc),
    // Identity never moves, even if the source URL does.
    guid: permalink,
    // Match the page, which links an Attachment straight at its file.
    link: rawHttpUrl(block.source?.url) || rawHttpUrl(block.attachment?.url) || permalink,
    pubDate: rfc822(block.connection?.connected_at),
    description: mdToPlain(block.type === "Text"
      ? block.content?.markdown
      : block.description?.markdown)
  };
}

function buildFeed(items, builtAt) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
  out.push("  <channel>");
  out.push("    <title>Paulo Reyes</title>");
  out.push("    <link>" + xmlEsc(SITE) + "</link>");
  out.push("    <description>" + xmlEsc(FEED_DESCRIPTION) + "</description>");
  out.push("    <language>en</language>");
  out.push('    <atom:link href="' + xmlEsc(FEED_URL) + '" rel="self" type="application/rss+xml"/>');
  const built = rfc822(builtAt);
  if (built) out.push("    <lastBuildDate>" + built + "</lastBuildDate>");

  for (const item of items) {
    out.push("    <item>");
    out.push("      <title>" + xmlEsc(item.title) + "</title>");
    out.push("      <link>" + xmlEsc(item.link) + "</link>");
    out.push('      <guid isPermaLink="false">' + xmlEsc(item.guid) + "</guid>");
    if (item.pubDate) out.push("      <pubDate>" + item.pubDate + "</pubDate>");
    if (item.description) out.push("      <description>" + cdata(item.description) + "</description>");
    out.push("    </item>");
  }

  out.push("  </channel>");
  out.push("</rss>");
  return out.join("\n") + "\n";
}

// Well-formedness check so a malformed feed is never written to disk.
function assertWellFormedXml(xml) {
  const fail = (msg, at) => {
    throw new Error("feed.xml is not well-formed: " + msg + " (offset " + at + ")");
  };
  const ENTITY = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

  const checkChars = (text, base, what) => {
    const lt = text.indexOf("<");
    if (lt !== -1) fail("raw '<' in " + what, base + lt);
    let m;
    const amps = [];
    for (let k = text.indexOf("&"); k !== -1; k = text.indexOf("&", k + 1)) amps.push(k);
    ENTITY.lastIndex = 0;
    const valid = new Set();
    while ((m = ENTITY.exec(text)) !== null) valid.add(m.index);
    for (const at of amps) if (!valid.has(at)) fail("bare '&' in " + what, base + at);
  };

  const stack = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) { checkChars(xml.slice(i), i, "text"); break; }
    checkChars(xml.slice(i, lt), i, "text");

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) fail("unterminated comment", lt);
      i = end + 3; continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) fail("unterminated CDATA section", lt);
      i = end + 3; continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) fail("unterminated processing instruction", lt);
      i = end + 2; continue;
    }

    const gt = xml.indexOf(">", lt);
    if (gt === -1) fail("unterminated tag", lt);
    let body = xml.slice(lt + 1, gt);
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1);

    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (open !== name) fail("</" + name + "> closes <" + (open || "nothing") + ">", lt);
    } else {
      const name = body.split(/[\s/]/)[0];
      if (!name) fail("empty tag name", lt);
      const attrs = body.slice(name.length);
      const quotes = (attrs.match(/"/g) || []).length;
      if (quotes % 2 !== 0) fail("unbalanced quotes in <" + name + ">", lt);
      checkChars(attrs.replace(/"/g, ""), lt, "attributes of <" + name + ">");
      if (!selfClosing) stack.push(name);
    }
    i = gt + 1;
  }
  if (stack.length) fail("unclosed <" + stack[stack.length - 1] + ">", xml.length);
  return true;
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

const feedItems = kept.map((b, i) => mapFeedItem(b, i + 1)).reverse();
const feed = buildFeed(feedItems, new Date());
assertWellFormedXml(feed);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, html);
await writeFile(OUT_FEED, feed);

const counts = {};
for (const r of records) counts[r.type] = (counts[r.type] ?? 0) + 1;

console.log(`fetched  ${raw.length} blocks, kept ${records.length}`);
for (const [type, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(12)} ${n}`);
}
console.log(`written  ${OUT_FILE.pathname}`);
console.log(`written  ${OUT_FEED.pathname} (${feedItems.length} items)`);
