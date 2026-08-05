import fs from "node:fs";
import path from "node:path";
import { transformSync } from "@babel/core";
import transformReactJsx from "@babel/plugin-transform-react-jsx";

const root = process.cwd();
const inputPath = path.join(root, "index.html");
const outputDir = path.join(root, "dist");
const outputPath = path.join(outputDir, "index.html");

const html = fs.readFileSync(inputPath, "utf8");
const scriptPattern = /<script\s+type="text\/babel"[^>]*>([\s\S]*?)<\/script>/i;
const match = html.match(scriptPattern);

if (!match) {
  throw new Error("Could not find the JSX script in index.html");
}

const compiled = transformSync(match[1], {
  plugins: [[transformReactJsx, { runtime: "classic" }]],
  sourceType: "script",
  compact: false,
  comments: false,
});

if (!compiled?.code) {
  throw new Error("Babel did not return compiled JavaScript");
}

const productionHtml = html
  .replace(/\s*<script src="https:\/\/unpkg\.com\/@babel\/standalone\/babel\.min\.js"><\/script>\s*/i, "\n")
  .replace(scriptPattern, `<script>\n${compiled.code}\n<\/script>`);

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, productionHtml, "utf8");

console.log(`Built ${outputPath}`);
