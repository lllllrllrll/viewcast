import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";

const root = process.cwd();
const outputDir = path.join(root, "docs", "youtube-analytics-experiment", "thumbnails");

const tests = [
  ["Clear close-up face", 9, "clear close up face interview"],
  ["Bold, readable text", 9, "bold readable text youtube tips"],
  ["Strong color contrast", 8, "high contrast color design"],
  ["Expressive reaction", 8, "shocked reaction challenge"],
  ["Relevant product image", 8, "iphone product review"],
  ["Balanced gaming scene", 7, "minecraft gameplay challenge"],
  ["Simple tutorial graphic", 7, "photoshop beginner tutorial"],
  ["Recognizable logo", 7, "famous logo history"],
  ["Ordinary video screenshot", 6, "ordinary daily vlog"],
  ["Subject appears too small", 5, "tiny person landscape"],
  ["Weak visual contrast", 5, "low contrast cinematography"],
  ["Excessive thumbnail text", 4, "too much text presentation"],
  ["Vague or unclear image", 4, "abstract mystery image"],
  ["Dull color palette", 4, "muted colors aesthetic vlog"],
  ["Cluttered image collage", 3, "cluttered collage challenge"],
  ["Blurry photograph", 3, "old blurry home video"],
  ["Misleading-subject test candidate", 2, "misleading clickbait explained"],
  ["Unreadable-text test candidate", 2, "small unreadable text lecture"],
  ["Blank-image test candidate", 1, "blank white screen video"],
  ["Unrelated-image test candidate", 1, "unrelated thumbnail clickbait"]
];

const headers = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  cookie: "SOCS=CAI; CONSENT=YES+cb.20210328-17-p0.en+FX+667"
};

function category(score) {
  return score >= 7 ? "Effective" : score >= 4 ? "Average" : "Ineffective";
}

function csv(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function fetchOk(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {headers});
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return response;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 800));
    }
  }
  throw lastError;
}

fs.mkdirSync(outputDir, {recursive: true});
const used = new Set();
const rows = [];

for (let index = 0; index < tests.length; index += 1) {
  const [condition, score, query] = tests[index];
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=US&app=desktop`;
  const html = execFileSync("curl", [
    "-sL",
    "--compressed",
    "-A",
    headers["user-agent"],
    "-H",
    `Cookie: ${headers.cookie}`,
    searchUrl
  ], {encoding: "utf8", maxBuffer: 8 * 1024 * 1024});
  const ids = [...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map((match) => match[1]);
  const videoId = ids.find((id) => !used.has(id));
  if (!videoId) throw new Error(`No unique video found for ${query}`);
  used.add(videoId);

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const metadata = await (await fetchOk(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`)).json();
  let thumbnailResponse = await fetch(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, {headers});
  if (!thumbnailResponse.ok || Number(thumbnailResponse.headers.get("content-length") || 0) < 1000) {
    thumbnailResponse = await fetchOk(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
  }

  const filename = `${String(index + 1).padStart(2, "0")}-${condition.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}.jpg`;
  fs.writeFileSync(path.join(outputDir, filename), Buffer.from(await thumbnailResponse.arrayBuffer()));
  rows.push({test: index + 1, condition, score, category: category(score), title: metadata.title, author: metadata.author_name, videoUrl, filename, query});
  console.log(`${index + 1}/20 ${metadata.title}`);
}

const manifestDir = path.dirname(outputDir);
const csvText = [
  ["Test", "Condition", "Expected Score", "Expected Category", "Video Title", "Creator", "Video URL", "Image File", "Actual Score", "Actual Category", "Correct?", "Notes"].map(csv).join(","),
  ...rows.map((row) => [row.test, row.condition, row.score, row.category, row.title, row.author, row.videoUrl, `thumbnails/${row.filename}`, "", "", "", "Confirm visually before testing"].map(csv).join(","))
].join("\n");
fs.writeFileSync(path.join(manifestDir, "thumbnail-test-manifest.csv"), `${csvText}\n`);

const markdown = [
  "# YouTube thumbnail experiment candidates",
  "",
  "> These public thumbnails are classroom test candidates. Visually confirm each one before using it; search results can change and quality labels are experimental judgments, not claims about a creator's work.",
  "",
  "| Test | Condition | Expected | Source | Image |",
  "|---:|---|---|---|---|",
  ...rows.map((row) => `| ${row.test} | ${row.condition} | ${row.score}/10 — ${row.category} | [${row.title.replaceAll("|", "\\|")}](${row.videoUrl}) | [${row.filename}](thumbnails/${row.filename}) |`)
].join("\n");
fs.writeFileSync(path.join(manifestDir, "README.md"), `${markdown}\n`);
