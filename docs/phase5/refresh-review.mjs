import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const guide = readFileSync(join(directory, "DEPLOYMENT-REVIEW.md"), "utf8");
const sql = readFileSync(join(directory, "production-schema-review.sql"), "utf8");
const outputPath = join(directory, "PHASE5-REVIEW.html");
let html = readFileSync(outputPath, "utf8");
const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");
const blocks = [...html.matchAll(/<pre>[\s\S]*?<\/pre>/g)];
if (blocks.length !== 2) throw new Error("Expected exactly two preview blocks");
let index = 0;
html = html.replace(/<pre>[\s\S]*?<\/pre>/g,
  () => `<pre>${escapeHtml(index++ === 0 ? guide : sql)}</pre>`);
const start = html.indexOf("const files=");
const end = html.indexOf(";function downloadFile(", start);
if (start < 0 || end < 0) throw new Error("Review download bundle is missing");
html = `${html.slice(0, start)}const files=${JSON.stringify({ guide, sql })}${html.slice(end)}`;
writeFileSync(outputPath, html);