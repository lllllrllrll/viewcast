import {cp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";

const outputDirectory = "dist";
const publicDirectories = ["components", "css", "js", "pages"];
const publicFiles = [
  "favicon.svg",
  "index.html",
  "login.html",
  "privacy.html",
  "terms.html",
  "thumbnail-analyzer.html",
];

await rm(outputDirectory, {recursive: true, force: true});
await mkdir(outputDirectory, {recursive: true});

await Promise.all([
  ...publicDirectories.map((directory) =>
    cp(directory, join(outputDirectory, directory), {recursive: true}),
  ),
  ...publicFiles.map((file) => cp(file, join(outputDirectory, file))),
]);

const stylesheetEntry = await readFile("css/style.css", "utf8");
const modulePaths = [...stylesheetEntry.matchAll(/@import url\("([^"]+)"\);/g)]
  .map((match) => join("css", match[1]));
const bundledStyles = await Promise.all(
  modulePaths.map((path) => readFile(path, "utf8")),
);
await writeFile(
  join(outputDirectory, "css", "style.css"),
  bundledStyles.join(""),
);

console.log(
  `Prepared ${outputDirectory}/ with public files and bundled CSS.`,
);
