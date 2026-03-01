import { readdir, readFile } from "node:fs/promises";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import cssnano from "cssnano";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const minify = process.argv.includes("--minify");
const positionalArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PALETTE_PATH = positionalArgs[0] || join(ROOT_DIR, "palette.json");
const STYLES_DIR = join(ROOT_DIR, "styles");

const palette = JSON.parse(await readFile(PALETTE_PATH, "utf-8"));

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return `${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}`;
}

function hexToHsl(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return `0 0% ${Math.round(l * 1000) / 10}%`;
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue = 0;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) hue = ((b - r) / d + 2) * 60;
  else hue = ((r - g) / d + 4) * 60;
  return `${Math.round(hue * 10) / 10} ${Math.round(s * 1000) / 10}% ${Math.round(l * 1000) / 10}%`;
}

function hexToOklch(hex) {
  const h = hex.replace("#", "");
  const ri = parseInt(h.slice(0, 2), 16) / 255;
  const gi = parseInt(h.slice(2, 4), 16) / 255;
  const bi = parseInt(h.slice(4, 6), 16) / 255;
  const toLinear = (c) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const lr = toLinear(ri);
  const lg = toLinear(gi);
  const lb = toLinear(bi);
  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l3 = Math.cbrt(l_);
  const m3 = Math.cbrt(m_);
  const s3 = Math.cbrt(s_);
  const L = 0.2104542553 * l3 + 0.793617785 * m3 - 0.0040720468 * s3;
  const a = 1.9779984951 * l3 - 2.428592205 * m3 + 0.4505937099 * s3;
  const bOk = 0.0259040371 * l3 + 0.7827717662 * m3 - 0.808675766 * s3;
  const C = Math.sqrt(a * a + bOk * bOk);
  let H = (Math.atan2(bOk, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return `${Math.round(L * 10000) / 10000} ${Math.round(C * 10000) / 10000} ${Math.round(H * 100) / 100}`;
}

const paletteVars = Object.entries(palette)
  .flatMap(([name, value]) => [
    `  --${name}: ${value};`,
    `  --${name}-rgb: ${hexToRgb(value)};`,
    `  --${name}-hsl: ${hexToHsl(value)};`,
    `  --${name}-oklch: ${hexToOklch(value)};`,
  ])
  .join("\n");

const addImportant = {
  postcssPlugin: "add-important-to-all",
  Declaration(decl) {
    if (!decl.important) {
      decl.important = true;
    }
  },
};

const stripBlanks = {
  postcssPlugin: "strip-blank-lines",
  OnceExit(root) {
    root.walk((node) => {
      if (node.raws.before) {
        node.raws.before = node.raws.before.replace(/\n\s*\n/g, "\n");
      }
      if (node.raws.after) {
        node.raws.after = node.raws.after.replace(/\n\s*\n/g, "\n");
      }
    });
  },
};

// Merge rules with identical declaration blocks into comma-separated selectors.
// Also merge :root blocks that appear at the same nesting level.
const mergeIdenticalRules = {
  postcssPlugin: "merge-identical-rules",
  OnceExit(root) {
    mergeRulesInContainer(root);
  },
};

function declFingerprint(rule) {
  const decls = [];
  rule.each((node) => {
    if (node.type === "decl") {
      decls.push(`${node.prop}:${node.value}${node.important ? "!" : ""}`);
    }
  });
  return decls.join(";");
}

function mergeRulesInContainer(container) {
  // First recurse into nested containers (at-rules, etc.)
  container.each((node) => {
    if (node.type === "atrule" && node.nodes) {
      mergeRulesInContainer(node);
    }
  });

  // Pass 1: merge :root rules (combine all declarations)
  const rootRules = [];
  container.each((node) => {
    if (node.type === "rule" && node.selector === ":root") {
      rootRules.push(node);
    }
  });
  if (rootRules.length > 1) {
    const target = rootRules[0];
    for (let i = 1; i < rootRules.length; i++) {
      rootRules[i].each((node) => {
        target.append(node.clone());
      });
      rootRules[i].remove();
    }
  }

  // Pass 2: merge rules with identical declaration blocks
  const seen = new Map();
  const order = [];
  container.each((node) => {
    if (node.type !== "rule") return;
    const fp = declFingerprint(node);
    if (!fp) return;
    if (seen.has(fp)) {
      const existing = seen.get(fp);
      // Append selectors, avoiding duplicates
      const existingSelectors = new Set(existing.selectors);
      for (const sel of node.selectors) {
        if (!existingSelectors.has(sel)) {
          existing.selectors = [...existing.selectors, sel];
        }
      }
      node.remove();
    } else {
      seen.set(fp, node);
      order.push(node);
    }
  });
}

const perFilePlugins = [addImportant, stripBlanks, mergeIdenticalRules];
const nanoPreset = ["default", { discardComments: { removeAll: true } }];

const files = (await readdir(STYLES_DIR)).filter((f) => f.endsWith(".css"));
const blocks = [];

for (const file of files) {
  const domain = basename(file, ".css");
  const raw = await readFile(join(STYLES_DIR, file), "utf-8");
  const result = await postcss(perFilePlugins).process(raw, { from: file });
  blocks.push(`@-moz-document domain("${domain}") {\n${result.css}\n}`);
}

let output = `:root {\n${paletteVars}\n}\n\n${blocks.join("\n\n")}\n`;

if (minify) {
  const finalPlugins = [mergeIdenticalRules, cssnano({ preset: nanoPreset })];
  const finalResult = await postcss(finalPlugins).process(output, {
    from: "usercontent.css",
  });
  output = finalResult.css;
} else {
  output = output
    .split("\n")
    .filter((line, i, arr) => line.trim() !== "" || arr[i - 1]?.trim() !== "")
    .join("\n");
}

process.stdout.write(output + "\n");
