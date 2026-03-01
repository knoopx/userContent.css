import { readdir, readFile } from "node:fs/promises";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PALETTE_PATH = process.argv[2] || join(ROOT_DIR, "palette.json");
const STYLES_DIR = join(ROOT_DIR, "styles");

const palette = JSON.parse(await readFile(PALETTE_PATH, "utf-8"));

const paletteVars = Object.entries(palette)
  .map(([name, value]) => `  --${name}: ${value};`)
  .join("\n");

const files = (await readdir(STYLES_DIR)).filter((f) => f.endsWith(".css"));
const blocks = [];

for (const file of files) {
  const domain = basename(file, ".css");
  const raw = await readFile(join(STYLES_DIR, file), "utf-8");
  const addImportant = {
    postcssPlugin: "add-important-to-all",
    Declaration(decl) {
      if (!decl.important) {
        decl.important = true;
      }
    },
  };
  const result = await postcss([addImportant]).process(raw, { from: file });
  const indented = result.css
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : ""))
    .join("\n");
  blocks.push(`@-moz-document domain("${domain}") {\n${indented}\n}`);
}

process.stdout.write(`:root {\n${paletteVars}\n}\n\n${blocks.join("\n\n")}\n`);
