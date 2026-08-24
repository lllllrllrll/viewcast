import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dir = path.join(root, "docs/youtube-analytics-experiment");
const candidates = JSON.parse(fs.readFileSync(path.join(dir, "new-thumbnail-candidates.json"), "utf8"));
const reviews = [
  [7.0, "Bold headline with strong contrast, although the gear itself is not shown."],
  [8.5, "Close-up food photography is appetizing, clear, and directly supports the recipe title."],
  [9.0, "Large destination text and a beautiful landscape create an immediate travel promise."],
  [3.5, "The dark abstract design has weak hierarchy and several tiny elements."],
  [4.0, "The room scene supports the makeover topic but lacks contrast and a strong focal point."],
  [9.0, "Large readable text, a friendly face, and the guitar communicate the lesson instantly."],
  [7.5, "The camera and bird establish wildlife photography, though the headline is lengthy."],
  [8.0, "The bright PC case and price create a clear, focused technology thumbnail."],
  [8.5, "The expressive face and short headline create curiosity and remain readable."],
  [8.0, "The Colosseum, bold title, and warm contrast clearly establish the history topic."],
  [4.5, "The minimalist room matches the vlog style but is dim and visually understated."],
  [5.0, "The image grid is relevant but busy, and the headline competes with several panels."],
  [8.5, "Large text, a clear face, and color samples communicate the design tutorial well."],
  [8.0, "Two faces, strong studio lighting, and the Riverside label establish a podcast review."],
  [8.5, "Strong green contrast, product images, and simple symbols make the comparison clear."],
  [5.5, "The restoration topic is understandable, but the small photos weaken mobile clarity."],
  [6.0, "Faces create emotion and curiosity, though the bedroom makeover is not immediately obvious."],
  [8.5, "The large PowerPoint headline, logo, and presenter make the lesson easy to identify."],
  [8.0, "Bold text and a photographer in the field clearly communicate a practical tutorial."],
  [5.5, "The artist and canvas fit the title, but the muted palette and thin lettering reduce impact."]
];
const actualScores = [6.5, 8.0, 9.0, 4.0, 4.5, 9.0, 7.0, 7.5, 8.0, 8.5, 5.0, 5.0, 8.0, 7.5, 8.5, 7.0, 7.0, 9.0, 7.5, 5.0];

function category(score) { return score >= 7 ? "Effective" : score >= 4 ? "Average" : "Ineffective"; }
function csv(value) { return `"${String(value).replaceAll('"', '""')}"`; }

const headers = ["Test", "Condition", "Expected Score", "Expected Category", "Video Title", "Creator", "Video URL", "Image File", "Actual Score", "Actual Category", "Correct?", "Notes"];
const rows = candidates.map((candidate, index) => {
  const [score, reason] = reviews[index];
  const actual = actualScores[index];
  const expectedCategory = category(score);
  const actualCategory = category(actual);
  return [index + 1, "Visual quality review", score.toFixed(1), expectedCategory, candidate.title, candidate.creator, candidate.url, `thumbnails/${candidate.filename}`, actual.toFixed(1), actualCategory, expectedCategory === actualCategory ? "Yes" : "No", `Expected-score rationale: ${reason} Actual score recorded during a separate second-pass visual evaluation.`];
});
fs.writeFileSync(path.join(dir, "thumbnail-test-manifest.csv"), [headers, ...rows].map(row => row.map(csv).join(",")).join("\n") + "\n");
