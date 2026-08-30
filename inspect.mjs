const url = "https://api.are.na/v3/channels/website-pulls/contents?per=100";
const res = await fetch(url, {
  headers: {
    Authorization: "Bearer " + process.env.ARENA_TOKEN,
    "User-Agent": "pauloreyes.com build script",
    Accept: "application/json"
  }
});
console.log("STATUS:", res.status);
const text = await res.text();

let data;
try { data = JSON.parse(text); } catch { console.log("RAW:", text.slice(0, 500)); process.exit(1); }

if (data.error) { console.log("ERROR:", JSON.stringify(data, null, 2)); process.exit(1); }

const items = data.data || [];
console.log("COUNT:", items.length, "of", data.meta?.total_count);
console.log("TYPES:", [...new Set(items.map(b => b.type))]);

const seen = new Set();
for (const b of items) {
  if (seen.has(b.type)) continue;
  seen.add(b.type);
  console.log("\n===== " + b.type + " =====");
  console.log(JSON.stringify(b, null, 2).slice(0, 2000));
}
