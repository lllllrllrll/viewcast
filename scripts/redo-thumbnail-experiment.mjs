import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";

const root = process.cwd();
const dir = path.join(root, "docs/youtube-analytics-experiment");
const imageDir = path.join(dir, "thumbnails");
const oldRows = fs.readFileSync(path.join(dir, "thumbnail-test-manifest.csv"), "utf8");
const oldIds = new Set([...oldRows.matchAll(/youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/g)].map(match => match[1]));
const queries = [
  "professional camera review 2025 full review",
  "easy pasta recipe cooking tutorial full video",
  "Japan travel documentary full video",
  "space science explained documentary",
  "home office makeover full video",
  "beginner guitar lesson full video",
  "wildlife photography tutorial full video",
  "PC build guide full video",
  "movie review video essay full video",
  "history documentary ancient Rome full video",
  "minimalist daily vlog full video",
  "cinematic landscape filmmaking tutorial",
  "graphic design color palette tutorial",
  "podcast interview full episode studio",
  "budget smartphone comparison full review",
  "old blurry footage restoration tutorial",
  "busy maximalist room makeover full video",
  "presentation design text mistakes full video",
  "dark low contrast photography tutorial full video",
  "abstract art process painting full video"
];
const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36";
const used = new Set(oldIds);
const candidates = [];

fs.mkdirSync(imageDir, {recursive: true});
for (let index = 0; index < queries.length; index++) {
  const query = queries[index];
  const html = execFileSync("curl", ["-sL", "--compressed", "-A", ua, `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=US&app=desktop`], {encoding: "utf8", maxBuffer: 12 * 1024 * 1024});
  const ids = [...new Set([...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map(match => match[1]))];
  let selected;
  for (const id of ids.slice(0, 20)) {
    if (used.has(id)) continue;
    try {
      const url = `https://www.youtube.com/watch?v=${id}`;
      const metadata = JSON.parse(execFileSync("curl", ["-sL", `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`], {encoding: "utf8"}));
      if (/\bshorts?\b|#shorts|\bvertical\b/i.test(metadata.title)) continue;
      selected = {id, url, title: metadata.title, creator: metadata.author_name};
      break;
    } catch {}
  }
  if (!selected) throw new Error(`No suitable video for ${query}`);
  used.add(selected.id);
  const filename = `${String(index + 1).padStart(2, "0")}-new-experiment-thumbnail.jpg`;
  const output = path.join(imageDir, filename);
  execFileSync("curl", ["-sL", "-A", ua, "-o", output, `https://i.ytimg.com/vi/${selected.id}/maxresdefault.jpg`]);
  if (fs.statSync(output).size < 1000) execFileSync("curl", ["-sL", "-o", output, `https://i.ytimg.com/vi/${selected.id}/hqdefault.jpg`]);
  candidates.push({...selected, query, filename});
  console.log(`${index + 1}: ${selected.title}`);
}
fs.writeFileSync(path.join(dir, "new-thumbnail-candidates.json"), JSON.stringify(candidates, null, 2) + "\n");
