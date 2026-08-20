import {cp, mkdir, rm} from "node:fs/promises";
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

console.log(`Prepared ${outputDirectory}/ with public website files only.`);
