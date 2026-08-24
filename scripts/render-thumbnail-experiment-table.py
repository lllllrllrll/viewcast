import csv
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs/youtube-analytics-experiment/thumbnail-test-manifest.csv"
OUTPUT = ROOT / "docs/youtube-analytics-experiment/thumbnail-analyzer-experiment-table.png"

WIDTH = 3400
MARGIN = 60
ROW_HEIGHT = 150
HEADER_HEIGHT = 74
TITLE_HEIGHT = 210
COLS = [
    ("Test", 100),
    ("Thumbnail", 285),
    ("Video Title", 620),
    ("Condition", 430),
    ("Expected Output", 300),
    ("Actual Output", 300),
    ("Correct?", 150),
    ("Notes", 1095),
]

FONT_REGULAR = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REGULAR, size)


def wrapped(value, width):
    return "\n".join(textwrap.wrap(str(value), width=width, break_long_words=False)[:4])


def thumbnail(path):
    source = Image.open(path).convert("RGB")
    source.thumbnail((245, 118), Image.Resampling.LANCZOS)
    frame = Image.new("RGB", (245, 118), "#e2e8f0")
    frame.paste(source, ((245 - source.width) // 2, (118 - source.height) // 2))
    return frame


with DATA.open(encoding="utf-8", newline="") as source:
    rows = list(csv.DictReader(source))

height = TITLE_HEIGHT + HEADER_HEIGHT + ROW_HEIGHT * len(rows) + MARGIN
image = Image.new("RGB", (WIDTH, height), "#f3f6fa")
draw = ImageDraw.Draw(image)

draw.text((MARGIN, 45), "Thumbnail Analyzer Experiment", fill="#172033", font=font(54, True))
draw.text((MARGIN, 115), "20 public YouTube thumbnails: expected results compared with manual visual-review outputs.", fill="#64748b", font=font(27))

completed = [row for row in rows if row["Actual Score"].strip()]
if completed:
    correct = sum(row["Correct?"] == "Yes" for row in completed)
    average = sum(float(row["Actual Score"]) for row in completed) / len(completed)
    summary = f"{len(rows)} tests     •     {correct} correct     •     {correct / len(completed):.0%} accuracy     •     {average:.2f}/10 average score"
else:
    summary = f"{len(rows)} new thumbnails     •     expected scores assigned after visual review     •     actual results pending"
draw.text((MARGIN, 160), summary, fill="#1769aa", font=font(27, True))

x = MARGIN
y = TITLE_HEIGHT
for label, width in COLS:
    draw.rectangle((x, y, x + width, y + HEADER_HEIGHT), fill="#172033")
    draw.text((x + 14, y + 21), label, fill="white", font=font(25, True))
    x += width

for index, row in enumerate(rows):
    y = TITLE_HEIGHT + HEADER_HEIGHT + index * ROW_HEIGHT
    background = "#ffffff" if index % 2 == 0 else "#f8fafc"
    values = [
        row["Test"],
        row["Image File"],
        row["Video Title"],
        row["Condition"],
        f'{row["Expected Score"]}/10 — {row["Expected Category"]}',
        f'{row["Actual Score"]}/10 — {row["Actual Category"]}' if row["Actual Score"].strip() else "Pending experiment",
        row["Correct?"],
        row["Notes"].replace("Manual visual review: ", ""),
    ]
    x = MARGIN
    for column, ((_, width), value) in enumerate(zip(COLS, values)):
        draw.rectangle((x, y, x + width, y + ROW_HEIGHT), fill=background, outline="#dbe3ee", width=1)
        if column == 1:
            preview = thumbnail(DATA.parent / value)
            image.paste(preview, (x + 20, y + 16))
        else:
            color = "#166534" if value == "Yes" else "#991b1b" if value == "No" else "#172033"
            wrap_width = [5, 1, 37, 25, 19, 19, 8, 67][column]
            draw.multiline_text((x + 14, y + 15), wrapped(value, wrap_width), fill=color, font=font(23, column == 6), spacing=5)
        x += width

image.save(OUTPUT, "PNG", optimize=True)
print(OUTPUT)
