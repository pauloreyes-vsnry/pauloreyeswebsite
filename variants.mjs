const res = await fetch("https://api.are.na/v3/channels/website-pulls/contents?per=100",
  { headers: { Authorization: "Bearer " + process.env.ARENA_TOKEN } });
const { data } = await res.json();
const img = data.find(b => b.image)?.image;
console.log("KEYS:", Object.keys(img));
for (const [k, v] of Object.entries(img)) {
  if (v && typeof v === "object") console.log(k, "=>", JSON.stringify(v));
}
