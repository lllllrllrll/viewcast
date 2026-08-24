import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";

const root = process.cwd();
const dir = path.join(root, "docs/youtube-analytics-experiment");
const jsonPath = path.join(dir, "new-thumbnail-candidates.json");
const candidates = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const searches = new Map([
  [17, "Mr Kate bedroom makeover OMG We're Coming Over"]
]);
const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36";
const used = new Set(candidates.map(item => item.id));

for (const [number, query] of searches) {
  const html = execFileSync("curl", ["-sL", "--compressed", "-A", ua, `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=US&app=desktop`], {encoding: "utf8", maxBuffer: 12 * 1024 * 1024});
  const ids = [...new Set([...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map(match => match[1]))];
  let replacement;
  for (const id of ids.slice(0, 20)) {
    if (used.has(id)) continue;
    try {
      const url = `https://www.youtube.com/watch?v=${id}`;
      const meta = JSON.parse(execFileSync("curl", ["-sL", `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`], {encoding: "utf8"}));
      if (/\bshorts?\b|#|\bvertical\b/i.test(meta.title)) continue;
      replacement = {id, url, title: meta.title, creator: meta.author_name, query, filename: candidates[number - 1].filename};
      break;
    } catch {}
  }
  if (!replacement) throw new Error(`No replacement for ${number}`);
  used.add(replacement.id);
  const output = path.join(dir, "thumbnails", replacement.filename);
  execFileSync("curl", ["-sL", "-A", ua, "-o", output, `https://i.ytimg.com/vi/${replacement.id}/maxresdefault.jpg`]);
  if (fs.statSync(output).size < 1000) execFileSync("curl", ["-sL", "-o", output, `https://i.ytimg.com/vi/${replacement.id}/hqdefault.jpg`]);
  candidates[number - 1] = replacement;
  console.log(`${number}: ${replacement.title}`);
}
fs.writeFileSync(jsonPath, JSON.stringify(candidates, null, 2) + "\n");
