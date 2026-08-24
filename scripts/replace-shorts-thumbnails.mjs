import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";

const root = process.cwd();
const manifestPath = path.join(root, "docs/youtube-analytics-experiment/thumbnail-test-manifest.csv");
const thumbnailDir = path.join(root, "docs/youtube-analytics-experiment/thumbnails");
const replacements = new Map([
  [4, "Sidemen react to viral videos full episode"],
  [6, "Luke TheNotable 100 days Minecraft hardcore"],
  [10, "B&H environmental portrait photography tutorial"]
]);
const headers = {"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36"};

function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') { field += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { row.push(field); field = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; if (row.some(Boolean)) rows.push(row); row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csv(value) { return `"${String(value).replaceAll('"', '""')}"`; }
const rows = parseCsv(fs.readFileSync(manifestPath, "utf8"));
const columns = rows[0];
const indexes = Object.fromEntries(columns.map((name, index) => [name, index]));
const used = new Set(rows.slice(1).map(row => row[indexes["Video URL"]].split("v=")[1]));

for (const row of rows.slice(1)) {
  const test = Number(row[indexes.Test]);
  if (!replacements.has(test)) continue;
  const query = replacements.get(test);
  const html = execFileSync("curl", ["-sL", "--compressed", "-A", headers["user-agent"], `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=US&app=desktop`], {encoding: "utf8", maxBuffer: 12 * 1024 * 1024});
  const ids = [...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map(match => match[1]);
  let selected;
  for (const id of [...new Set(ids)].slice(0, 12)) {
    if (used.has(id)) continue;
    const url = `https://www.youtube.com/watch?v=${id}`;
    try {
      const metadata = JSON.parse(execFileSync("curl", ["-sL", `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`], {encoding: "utf8"}));
      if (/\bshorts?\b|#shorts/i.test(metadata.title)) continue;
      selected = {id, url, metadata}; break;
    } catch {}
  }
  if (!selected) throw new Error(`No non-Shorts candidate for test ${test}`);
  used.add(selected.id);
  const imagePath = path.join(root, "docs/youtube-analytics-experiment", row[indexes["Image File"]]);
  execFileSync("curl", ["-sL", "-A", headers["user-agent"], "-o", imagePath, `https://i.ytimg.com/vi/${selected.id}/maxresdefault.jpg`]);
  if (fs.statSync(imagePath).size < 1000) execFileSync("curl", ["-sL", "-o", imagePath, `https://i.ytimg.com/vi/${selected.id}/hqdefault.jpg`]);
  row[indexes["Video Title"]] = selected.metadata.title;
  row[indexes.Creator] = selected.metadata.author_name;
  row[indexes["Video URL"]] = selected.url;
  row[indexes.Notes] = row[indexes.Notes].replace("Manual visual review: ", "Manual visual review after replacing a Shorts-style candidate: ");
  console.log(`${test}: ${selected.metadata.title}`);
}

fs.writeFileSync(manifestPath, rows.map(row => row.map(csv).join(",")).join("\n") + "\n");
