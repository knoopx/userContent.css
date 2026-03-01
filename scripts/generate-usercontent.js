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

const paletteVars = Object.entries(palette)
  .map(([name, value]) => `  --${name}: ${value};`)
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
