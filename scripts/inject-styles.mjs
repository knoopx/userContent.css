#!/usr/bin/env node
// Inject palette + domain-matched userstyles into bruvtab-controlled Firefox tabs.
//
// Usage:
//   node scripts/inject-styles.mjs          # inject into every tab that has a matching style
//   node scripts/inject-styles.mjs a.1.1    # inject into one tab (bruvtab tab id / title / URL fragment)
//
// Requires: bruvtab on PATH with a Firefox mediator that supports the `eval` command.
// Reads:    palette.json, styles/*.css (relative to the project root).

import { readdir, readFile } from "node:fs/promises";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import postcss from "postcss";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STYLES_DIR = join(ROOT, "styles");
const PALETTE_PATH = join(ROOT, "palette.json");

// --- Color conversions (hex -> css component strings) ---

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
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
  const Lr = Math.round(L * 10000) / 10000;
  const Cr = Math.round(C * 10000) / 10000;
  const Hr = Math.round(H * 100) / 100;
  return `${Lr} ${Cr} ${Hr}`;
}

// --- Load palette + styles ---

async function loadPaletteCSS() {
  const raw = await readFile(PALETTE_PATH, "utf-8");
  const palette = JSON.parse(raw);
  const vars = Object.entries(palette)
    .flatMap(([name, value]) => [
      `  --${name}: ${value};`,
      `  --${name}-rgb: ${hexToRgb(value)};`,
      `  --${name}-hsl: ${hexToHsl(value)};`,
      `  --${name}-oklch: ${hexToOklch(value)};`,
    ])
    .join("\n");
  return `:root {\n${vars}\n}`;
}

async function loadStyles() {
  const files = await readdir(STYLES_DIR).catch(() => []);
  const styles = [];
  for (const file of files) {
    if (!file.endsWith(".css")) continue;
    styles.push({
      domain: basename(file, ".css"),
      css: await readFile(join(STYLES_DIR, file), "utf-8"),
    });
  }
  return styles;
}

function domainMatches(url, domain) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

// --- !important + rule splitting ---

const addImportantPlugin = {
  postcssPlugin: "add-important-to-all",
  Declaration(decl) {
    if (!decl.important) decl.important = true;
  },
};
const processor = postcss([addImportantPlugin]);

async function buildRules(css) {
  const result = await processor.process(css, { from: undefined });
  const parsed = postcss.parse(result.css);
  return parsed.nodes.map((node) => node.toString());
}

// --- bruvtab ---

function bruvtab(...args) {
  return execFileSync("bruvtab", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// `bruvtab list` -> lines of "<tab_id>\t<title>\t<URL>"
function listTabs() {
  const out = bruvtab("list").trim();
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => {
      const [id, title, ...urlParts] = line.split("\t");
      return { id, title: title ?? "", url: urlParts.join("\t") };
    })
    .filter((t) => t.id && t.url && t.url !== "about:blank");
}

function evalInTab(tabId, expression) {
  return bruvtab("eval", expression, tabId).trim();
}

// --- Injection snippet (CSSOM) ---

function injectionSnippet(rules) {
  const rulesJson = JSON.stringify(rules);
  return `(() => {
    const id = "__usercss__";
    let el = document.getElementById(id);
    if (el) el.remove();
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
    const rules = ${rulesJson};
    for (const rule of rules) {
      try { el.sheet.insertRule(rule, el.sheet.cssRules.length); } catch (e) {}
    }
    return rules.length + " rules";
  })()`;
}

// --- Main ---

async function main() {
  const tabArg = process.argv[2];
  const [paletteCSS, styles] = await Promise.all([
    loadPaletteCSS(),
    loadStyles(),
  ]);

  const allTabs = listTabs();
  if (allTabs.length === 0) {
    console.log("No tabs (is Firefox running with the bruvtab mediator?)");
    return;
  }

  let targets;
  if (tabArg) {
    const tab = allTabs.find(
      (t) =>
        t.id === tabArg || t.title.includes(tabArg) || t.url.includes(tabArg),
    );
    if (!tab) {
      console.log(`No tab matching: ${tabArg}`);
      return;
    }
    targets = [tab];
  } else {
    targets = allTabs;
  }

  const results = [];
  for (const tab of targets) {
    const matched = styles.filter((s) => domainMatches(tab.url, s.domain));
    if (matched.length === 0) {
      results.push(`skip: ${tab.url} (no matching style)`);
      continue;
    }
    const combined = [paletteCSS, ...matched.map((s) => s.css)].join("\n\n");
    const rules = await buildRules(combined);
    const out = evalInTab(tab.id, injectionSnippet(rules));
    results.push(
      `injected: ${tab.url} (${matched
        .map((s) => s.domain)
        .join(", ")}) -> ${out}`,
    );
  }
  console.log(results.join("\n"));
}

export {
  hexToRgb,
  hexToHsl,
  hexToOklch,
  loadPaletteCSS,
  loadStyles,
  domainMatches,
  buildRules,
  injectionSnippet,
};

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => {
    console.error(`Failed: ${e.message}`);
    process.exit(1);
  });
}
