import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

const postcss = require("postcss");

const MAX_LINES = 5000;
function truncateLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) return text;
  return (
    lines.slice(0, MAX_LINES).join("\n") +
    `\n... truncated (${lines.length - MAX_LINES} more lines)`
  );
}

const addImportantPlugin = {
  postcssPlugin: "add-important-to-all",
  Declaration(decl: any) {
    if (!decl.important) {
      decl.important = true;
    }
  },
};

const processor = postcss([addImportantPlugin]);

const ROOT_DIR = process.cwd();
const STYLES_DIR = join(ROOT_DIR, "styles");
const PALETTE_PATH = join(ROOT_DIR, "palette.json");
const FIREFOX_BIN = "firefox-esr";
const DEBUG_PORT = 9222;

// --- Minimal Firefox Remote Debugging Protocol client ---

class RDPClient extends EventEmitter {
  private socket: Socket | null = null;
  private incoming = Buffer.alloc(0);
  private pending: Array<{
    to: string;
    message: any;
    resolve: (v: any) => void;
  }> = [];
  private active: Record<string, (v: any) => void> = {};

  connect(port: number, host = "127.0.0.1"): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection({ host, port });
      this.socket.on("connect", () => resolve());
      this.socket.on("error", reject);
      this.socket.on("data", (data) => {
        this.incoming = Buffer.concat([this.incoming, data]);
        while (this.readMessage()) {}
      });
    });
  }

  disconnect() {
    this.socket?.destroy();
    this.socket = null;
  }

  private readMessage(): boolean {
    const str = this.incoming.toString();
    const sep = str.indexOf(":");
    if (sep < 0) return false;
    const len = parseInt(str.slice(0, sep), 10);
    if (this.incoming.length - (sep + 1) < len) return false;
    this.incoming = this.incoming.slice(sep + 1);
    const packet = this.incoming.slice(0, len);
    this.incoming = this.incoming.slice(len);
    try {
      const msg = JSON.parse(packet.toString());
      this.handleMessage(msg);
    } catch {}
    return true;
  }

  private handleMessage(msg: any) {
    // If there's an active request waiting for this actor's response, deliver it
    if (msg.from && this.active[msg.from]) {
      const cb = this.active[msg.from];
      delete this.active[msg.from];
      cb(msg);
      this.flush();
    }
    // Always emit for unsolicited events
    this.emit("message", msg);
  }

  request(message: any): Promise<any> {
    return new Promise((resolve) => {
      this.pending.push({ to: message.to, message, resolve });
      this.flush();
    });
  }

  private flush() {
    this.pending = this.pending.filter((req) => {
      if (this.active[req.to]) return true;
      this.send(req.message);
      this.active[req.to] = req.resolve;
      return false;
    });
  }

  private send(msg: any) {
    const str = JSON.stringify(msg);
    const payload = `${Buffer.byteLength(str)}:${str}`;
    this.socket?.write(payload);
  }

  sendRaw(msg: any) {
    this.send(msg);
  }
}

// --- Browser management ---

let client: RDPClient | null = null;
let firefoxProcess: ChildProcess | null = null;
let chromeConsoleActor: string | null = null;

function cleanup() {
  client?.disconnect();
  client = null;
  tabActorCache.clear();
  chromeConsoleActor = null;
  if (firefoxProcess) {
    try {
      firefoxProcess.kill("SIGKILL");
    } catch {}
    firefoxProcess = null;
  }
}

async function killExisting(): Promise<void> {
  try {
    execSync("pkill -9 -f 'firefox.*start-debugger'", { stdio: "ignore" });
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));
}

async function waitForPort(
  port: number,
  host = "127.0.0.1",
  timeout = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = createConnection({ host, port });
        s.on("connect", () => {
          s.destroy();
          resolve();
        });
        s.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Timeout waiting for port ${port}`);
}

async function connectToFirefox(): Promise<void> {
  client?.disconnect();
  client = null;
  tabActorCache.clear();
  chromeConsoleActor = null;

  client = new RDPClient();
  client.setMaxListeners(0);
  await client.connect(DEBUG_PORT);

  // Read the initial greeting
  await new Promise<void>((resolve) => {
    const handler = (msg: any) => {
      if (msg.from === "root") {
        client!.removeListener("message", handler);
        resolve();
      }
    };
    client!.on("message", handler);
  });
}

async function launchFirefox(url: string): Promise<void> {
  await killExisting();

  const profileDir = mkdtempSync(join(tmpdir(), "firefox_profile-"));
  const prefs = [
    "user_pref('devtools.chrome.enabled', true);",
    "user_pref('devtools.debugger.prompt-connection', false);",
    "user_pref('devtools.debugger.remote-enabled', true);",
    "user_pref('toolkit.telemetry.reportingpolicy.firstRun', false);",
    "user_pref('datareporting.policy.dataSubmissionEnabled', false);",
    "user_pref('browser.shell.checkDefaultBrowser', false);",
    "user_pref('browser.startup.homepage_override.mstone', 'ignore');",
    "user_pref('browser.tabs.warnOnClose', false);",
  ].join("\n");
  writeFileSync(join(profileDir, "prefs.js"), prefs);

  firefoxProcess = spawn(
    FIREFOX_BIN,
    [
      "-profile",
      profileDir,
      "-start-debugger-server",
      String(DEBUG_PORT),
      "-url",
      url,
    ],
    { stdio: "ignore" },
  );

  await waitForPort(DEBUG_PORT);
  await connectToFirefox();
}

async function getChromeConsoleActor(): Promise<string> {
  if (chromeConsoleActor) return chromeConsoleActor;
  if (!client) throw new Error("Not connected");
  const processResp = await client.request({
    to: "root",
    type: "getProcess",
    id: 0,
  });
  const pdActor = processResp.processDescriptor?.actor;
  if (!pdActor) throw new Error("No process descriptor");
  const pdTarget = await client.request({ to: pdActor, type: "getTarget" });
  chromeConsoleActor = pdTarget.process?.consoleActor as string;
  if (!chromeConsoleActor) throw new Error("No chrome console actor");
  return chromeConsoleActor;
}

async function evalInChrome(expression: string): Promise<string> {
  if (!client) throw new Error("Not connected");
  const actor = await getChromeConsoleActor();

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client!.removeListener("message", handler);
      reject(new Error("chrome eval timeout"));
    }, 5000);

    const handler = (msg: any) => {
      if (msg.from === actor && msg.type === "evaluationResult") {
        client!.removeListener("message", handler);
        clearTimeout(timeout);
        if (msg.hasException) {
          reject(new Error(msg.exceptionMessage || "chrome evaluation error"));
        } else {
          resolveGrip(msg.result).then(resolve, reject);
        }
      }
    };
    client!.on("message", handler);
    client!.sendRaw({
      to: actor,
      type: "evaluateJSAsync",
      text: expression,
      mapped: { await: true },
    });
  });
}

async function resolveGrip(result: any): Promise<string> {
  if (typeof result === "string") return result;
  if (result === null) return "null";
  if (result === undefined) return "undefined";
  if (typeof result === "number" || typeof result === "boolean")
    return String(result);
  if (result?.type === "undefined") return "undefined";
  if (result?.type === "longString" && result.actor && client) {
    const resp = await client.request({
      to: result.actor,
      type: "substring",
      start: 0,
      end: result.length,
    });
    return resp.substring || "";
  }
  if (result?.type === "longString") return result.initial || "";
  return JSON.stringify(result, null, 2);
}

const tabActorCache = new Map<string, { consoleActor: string }>();

async function getTabActors(tab: any): Promise<{ consoleActor: string }> {
  if (!client) throw new Error("Not connected");
  const cached = tabActorCache.get(tab.actor);
  if (cached) return cached;
  const target = await client.request({ to: tab.actor, type: "getTarget" });
  const result = { consoleActor: target.frame.consoleActor as string };
  tabActorCache.set(tab.actor, result);
  return result;
}

async function listTabs(): Promise<any[]> {
  if (!client) {
    try {
      await connectToFirefox();
    } catch {
      return [];
    }
  }
  try {
    const resp = await client!.request({ to: "root", type: "listTabs" });
    return (resp.tabs || []).filter(
      (t: any) => t.url && t.url !== "about:blank",
    );
  } catch {
    try {
      await connectToFirefox();
      const resp = await client!.request({ to: "root", type: "listTabs" });
      return (resp.tabs || []).filter(
        (t: any) => t.url && t.url !== "about:blank",
      );
    } catch {
      return [];
    }
  }
}

async function evalInTab(
  tab: any,
  expression: string,
  retry = true,
): Promise<string> {
  if (!client) throw new Error("Not connected");
  const { consoleActor } = await getTabActors(tab);

  try {
    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client!.removeListener("message", handler);
        reject(new Error("eval timeout"));
      }, 5000);

      const handler = (msg: any) => {
        if (msg.from === consoleActor && msg.type === "evaluationResult") {
          client!.removeListener("message", handler);
          clearTimeout(timeout);
          if (msg.hasException) {
            reject(new Error(msg.exceptionMessage || "evaluation error"));
          } else {
            resolveGrip(msg.result).then(resolve, reject);
          }
        }
      };
      client!.on("message", handler);
      client!.sendRaw({
        to: consoleActor,
        type: "evaluateJSAsync",
        text: expression,
      });
    });
  } catch (e: any) {
    if (retry && e.message === "eval timeout") {
      tabActorCache.delete(tab.actor);
      return evalInTab(tab, expression, false);
    }
    throw e;
  }
}

// --- Style helpers ---

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function hexToHsl(hex: string): string {
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

async function loadPaletteCSS(): Promise<string> {
  const raw = await readFile(PALETTE_PATH, "utf-8");
  const palette: Record<string, string> = JSON.parse(raw);
  const vars = Object.entries(palette)
    .flatMap(([name, value]) => [
      `  --${name}: ${value};`,
      `  --${name}-rgb: ${hexToRgb(value)};`,
      `  --${name}-hsl: ${hexToHsl(value)};`,
    ])
    .join("\n");
  return `:root {\n${vars}\n}`;
}

async function loadStyles(): Promise<{ domain: string; css: string }[]> {
  const files = await readdir(STYLES_DIR).catch(() => []);
  const styles: { domain: string; css: string }[] = [];
  for (const file of files) {
    if (!file.endsWith(".css")) continue;
    styles.push({
      domain: basename(file, ".css"),
      css: await readFile(join(STYLES_DIR, file), "utf-8"),
    });
  }
  return styles;
}

function domainMatches(url: string, domain: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

async function addImportant(css: string): Promise<string> {
  const result = await processor.process(css, { from: undefined });
  return result.css;
}

function escapeForTemplate(css: string): string {
  return css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    cleanup();
  });

  pi.registerTool({
    name: "launch-browser",
    label: "Launch Firefox",
    description:
      "Launch Firefox with DevTools protocol enabled. Call before other tools.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL to open" })),
    }),
    async execute(_id, params) {
      try {
        await launchFirefox(params.url || "about:blank");
        return {
          content: [
            { type: "text", text: "Firefox launched on port " + DEBUG_PORT },
          ],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "list-browser-tabs",
    label: "List Tabs",
    description: "List open Firefox tabs with their URLs.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const tabs = await listTabs();
        if (tabs.length === 0) {
          return {
            content: [{ type: "text", text: "No tabs (is Firefox running?)" }],
          };
        }
        const lines = tabs.map((t: any, i: number) => `${i}: ${t.url}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "inject-styles-into-tab",
    label: "Inject Styles",
    description:
      "Inject palette + matching userstyles into tabs. Optionally target a specific tab index or URL pattern.",
    parameters: Type.Object({
      tab: Type.Optional(Type.Number({ description: "Tab index from tabs" })),
      url: Type.Optional(
        Type.String({ description: "URL substring to match" }),
      ),
    }),
    async execute(_id, params) {
      try {
        const [paletteCSS, styles] = await Promise.all([
          loadPaletteCSS(),
          loadStyles(),
        ]);
        const tabs = await listTabs();
        if (tabs.length === 0) {
          return { content: [{ type: "text", text: "No tabs" }] };
        }

        const targets =
          params.tab !== undefined
            ? [tabs[params.tab]].filter(Boolean)
            : params.url
              ? tabs.filter((t: any) => t.url.includes(params.url))
              : tabs;

        const results: string[] = [];
        for (const tab of targets) {
          const url = tab.url;
          const matched = styles.filter((s) => domainMatches(url, s.domain));
          if (matched.length === 0) {
            results.push(`skip: ${url} (no matching style)`);
            continue;
          }
          const raw = [paletteCSS, ...matched.map((s) => s.css)].join("\n\n");
          const combined = await addImportant(raw);
          const escaped = escapeForTemplate(combined);
          await evalInTab(
            tab,
            `(() => {
            const id = "__usercss__";
            let el = document.getElementById(id);
            if (!el) { el = document.createElement("style"); el.id = id; document.head.appendChild(el); }
            el.textContent = \`${escaped}\`;
          })()`,
          );
          results.push(
            `injected: ${url} (${matched.map((s) => s.domain).join(", ")})`,
          );
        }
        return { content: [{ type: "text", text: results.join("\n") }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "eval-js-expression-in-tab",
    label: "Evaluate JS",
    description:
      "Evaluate a JavaScript expression in a browser tab and return the result. Use for DOM inspection, computed style queries, debugging.",
    parameters: Type.Object({
      expression: Type.String({ description: "JS expression to evaluate" }),
      tab: Type.Optional(
        Type.Number({ description: "Tab index (default: 0)" }),
      ),
    }),
    async execute(_id, params) {
      try {
        const tabs = await listTabs();
        const tab = tabs[params.tab ?? 0];
        if (!tab) {
          return {
            content: [{ type: "text", text: "No tab at that index" }],
            isError: true,
          };
        }
        const result = await evalInTab(tab, params.expression);
        return { content: [{ type: "text", text: truncateLines(result) }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "query-elements-by-selector",
    label: "Query DOM",
    description:
      "Query DOM elements by CSS selector. Returns tag, classes, inline styles, computed color/opacity, and text content for each match.",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector" }),
      tab: Type.Optional(
        Type.Number({ description: "Tab index (default: 0)" }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max elements to return (default: 10)" }),
      ),
      properties: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "CSS properties to read (default: color, background-color, opacity)",
        }),
      ),
    }),
    async execute(_id, params) {
      try {
        const tabs = await listTabs();
        const tab = tabs[params.tab ?? 0];
        if (!tab) {
          return {
            content: [{ type: "text", text: "No tab at that index" }],
            isError: true,
          };
        }
        const limit = params.limit ?? 10;
        const props = JSON.stringify(
          params.properties ?? ["color", "background-color", "opacity"],
        );
        const result = await evalInTab(
          tab,
          `(() => {
          const els = document.querySelectorAll(${JSON.stringify(params.selector)});
          const out = [];
          for (let i = 0; i < Math.min(els.length, ${limit}); i++) {
            const el = els[i];
            const cs = getComputedStyle(el);
            const props = ${props};
            const computed = {};
            for (const p of props) computed[p] = cs.getPropertyValue(p);
            let opacityChain = [];
            let p = el;
            while (p) {
              const o = getComputedStyle(p).opacity;
              if (o !== "1") opacityChain.push(p.tagName + (p.className ? "." + String(p.className).split(" ")[0] : "") + " opacity:" + o);
              p = p.parentElement;
            }
            out.push({
              tag: el.tagName,
              classes: el.className,
              id: el.id || undefined,
              inline: el.getAttribute("style") || undefined,
              text: el.textContent?.slice(0, 120),
              computed,
              opacityChain: opacityChain.length ? opacityChain : undefined,
            });
          }
          return JSON.stringify({ total: els.length, elements: out });
        })()`,
        );
        return { content: [{ type: "text", text: truncateLines(result) }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "get-computed-css-vars-from-element",
    label: "Read CSS Variables",
    description:
      "Read computed CSS custom property values from a specific element or :root.",
    parameters: Type.Object({
      variables: Type.Array(Type.String(), {
        description: "CSS variable names (e.g. --color-text-primary)",
      }),
      selector: Type.Optional(
        Type.String({ description: "Element selector (default: :root)" }),
      ),
      tab: Type.Optional(
        Type.Number({ description: "Tab index (default: 0)" }),
      ),
    }),
    async execute(_id, params) {
      try {
        const tabs = await listTabs();
        const tab = tabs[params.tab ?? 0];
        if (!tab) {
          return {
            content: [{ type: "text", text: "No tab at that index" }],
            isError: true,
          };
        }
        const sel = params.selector ?? ":root";
        const vars = JSON.stringify(params.variables);
        const result = await evalInTab(
          tab,
          `(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return JSON.stringify({ error: "no element for " + ${JSON.stringify(sel)} });
          const cs = getComputedStyle(el);
          const out = {};
          for (const v of ${vars}) out[v] = cs.getPropertyValue(v).trim();
          return JSON.stringify(out);
        })()`,
        );
        return { content: [{ type: "text", text: truncateLines(result) }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "navigate-tab-to-url",
    label: "Navigate Tab",
    description: "Navigate a tab to a URL.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
      tab: Type.Optional(
        Type.Number({ description: "Tab index (default: 0)" }),
      ),
    }),
    async execute(_id, params) {
      try {
        const tabs = await listTabs();
        const tab = tabs[params.tab ?? 0];
        if (!tab) {
          return {
            content: [{ type: "text", text: "No tab at that index" }],
            isError: true,
          };
        }
        await evalInTab(
          tab,
          `window.location.href = ${JSON.stringify(params.url)}`,
        );
        return {
          content: [{ type: "text", text: `Navigated to ${params.url}` }],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "extract-css-vars-from-stylesheets",
    label: "Extract Colors",
    description:
      "Extract CSS custom property declarations from a local CSS file or from the live page's stylesheets. When using 'file', extracts only --var declarations with hardcoded color values. When using 'tab', extracts all --var declarations from the page's stylesheets, optionally filtered by variable name pattern.",
    parameters: Type.Object({
      file: Type.Optional(
        Type.String({ description: "Path to local CSS file" }),
      ),
      tab: Type.Optional(
        Type.Number({
          description: "Tab index to extract from live page (default: 0)",
        }),
      ),
      pattern: Type.Optional(
        Type.String({
          description:
            "Filter variable names by substring (e.g. 'color-link', 'background'). Only used with tab.",
        }),
      ),
      selector: Type.Optional(
        Type.String({
          description:
            "Filter by rule selector substring (e.g. ':root', 'dark'). Only used with tab.",
        }),
      ),
    }),
    async execute(_id, params) {
      try {
        // Local file mode
        if (params.file) {
          const css = await readFile(params.file, "utf-8");
          const root = postcss.parse(css);
          const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i;

          const results: { selector: string; prop: string; value: string }[] =
            [];
          root.walk((node: any) => {
            if (node.type !== "decl") return;
            if (!node.prop.startsWith("--")) return;
            if (!COLOR_RE.test(node.value.trim())) return;

            const selectors: string[] = [];
            let parent = node.parent;
            while (parent && parent.type !== "root") {
              if (parent.type === "rule") selectors.unshift(parent.selector);
              else if (parent.type === "atrule")
                selectors.unshift(`@${parent.name} ${parent.params}`);
              parent = parent.parent;
            }
            results.push({
              selector: selectors.join(" "),
              prop: node.prop,
              value: node.value,
            });
          });

          const lines: string[] = [];
          let currentSelector = "";
          for (const { selector, prop, value } of results) {
            if (selector !== currentSelector) {
              if (currentSelector) lines.push("}");
              lines.push(`${selector} {`);
              currentSelector = selector;
            }
            lines.push(`  ${prop}: ${value};`);
          }
          if (currentSelector) lines.push("}");

          return {
            content: [{ type: "text", text: truncateLines(lines.join("\n")) }],
          };
        }

        // Live page mode
        const tabs = await listTabs();
        const tab = tabs[params.tab ?? 0];
        if (!tab) {
          return {
            content: [{ type: "text", text: "No tab at that index" }],
            isError: true,
          };
        }

        const pattern = params.pattern ?? "";
        const selectorFilter = params.selector ?? "";

        const result = await evalInTab(
          tab,
          `(() => {
            const pat = ${JSON.stringify(pattern)}.toLowerCase();
            const selF = ${JSON.stringify(selectorFilter)}.toLowerCase();
            const out = [];
            for (const sheet of document.styleSheets) {
              try {
                const scan = (rules, mediaPrefix) => {
                  for (const rule of rules) {
                    if (rule.cssRules && rule.cssRules.length) {
                      const prefix = rule.media
                        ? "@media " + rule.conditionText
                        : rule.name
                          ? "@" + rule.name + " " + (rule.conditionText || "")
                          : "";
                      scan(rule.cssRules, prefix);
                    }
                    if (!rule.style) continue;
                    const sel = (mediaPrefix ? mediaPrefix + " " : "") + (rule.selectorText || "");
                    if (selF && !sel.toLowerCase().includes(selF)) continue;
                    for (let i = 0; i < rule.style.length; i++) {
                      const prop = rule.style[i];
                      if (!prop.startsWith("--")) continue;
                      if (pat && !prop.toLowerCase().includes(pat)) continue;
                      const value = rule.style.getPropertyValue(prop).trim();
                      if (/var\\(|calc\\(|env\\(/.test(value)) continue;
                      if (!/^(#[0-9a-f]{3,8}|rgba?\\(|hsla?\\(|oklch\\(|oklab\\(|lch\\(|lab\\(|color\\(|hwb\\()/i.test(value)) continue;
                      out.push({ sel, prop, value });
                    }
                  }
                };
                scan(sheet.cssRules, "");
              } catch (e) {}
            }
            return JSON.stringify(out);
          })()`,
        );

        const entries = JSON.parse(result) as {
          sel: string;
          prop: string;
          value: string;
        }[];
        const lines: string[] = [];
        let currentSelector = "";
        for (const { sel, prop, value } of entries) {
          if (sel !== currentSelector) {
            if (currentSelector) lines.push("}");
            lines.push(`${sel} {`);
            currentSelector = sel;
          }
          lines.push(`  ${prop}: ${value};`);
        }
        if (currentSelector) lines.push("}");

        return {
          content: [
            {
              type: "text",
              text: lines.length
                ? truncateLines(lines.join("\n"))
                : "No matching CSS variables found.",
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "close-tab",
    label: "Close Tab",
    description: "Close a browser tab by index.",
    parameters: Type.Object({
      tab: Type.Number({ description: "Tab index from tabs" }),
    }),
    async execute(_id, params) {
      try {
        const tabs = await listTabs();
        const tab = tabs[params.tab];
        if (!tab) {
          return {
            content: [{ type: "text", text: "No tab at that index" }],
            isError: true,
          };
        }
        const url = tab.url;
        await evalInTab(tab, "window.close()");
        return { content: [{ type: "text", text: `Closed: ${url}` }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "reload-tab",
    label: "Reload Tab",
    description: "Reload a browser tab.",
    parameters: Type.Object({
      tab: Type.Optional(
        Type.Number({ description: "Tab index (default: 0)" }),
      ),
    }),
    async execute(_id, params) {
      try {
        const tabs = await listTabs();
        const idx = params.tab ?? 0;
        const tab = tabs[idx];
        if (!tab) {
          return {
            content: [{ type: "text", text: "No tab at that index" }],
            isError: true,
          };
        }
        await evalInTab(tab, "location.reload()");
        return { content: [{ type: "text", text: `Reloaded: ${tab.url}` }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  async function captureScreenshot(
    tab: any,
    rectX: number,
    rectY: number,
    rectW: number,
    rectH: number,
  ) {
    const dataUrl = await evalInChrome(`
      (async () => {
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        if (!win) throw new Error("no browser window");
        const browser = win.gBrowser.selectedBrowser;
        const bc = browser.browsingContext;
        const snapshot = await bc.currentWindowGlobal.drawSnapshot(
          new DOMRect(${rectX}, ${rectY}, ${rectW}, ${rectH}),
          1.0, "rgb(255,255,255)"
        );
        const MAX = 8000;
        let w = snapshot.width, h = snapshot.height;
        if (w > MAX || h > MAX) {
          const s = Math.min(MAX / w, MAX / h);
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext("2d");
        ctx.drawImage(snapshot, 0, 0, w, h);
        snapshot.close();
        const blob = await c.convertToBlob({ type: "image/png" });
        const ab = await blob.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return "data:image/png;base64," + btoa(binary);
      })()
    `);

    if (dataUrl.startsWith("data:image/png")) {
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      return {
        content: [
          { type: "text", text: "Screenshot captured." },
          { type: "image", data: b64, mimeType: "image/png" },
        ],
        details: {},
      };
    }

    return {
      content: [
        { type: "text", text: "Screenshot failed: " + dataUrl.slice(0, 200) },
      ],
      isError: true,
    };
  }

  pi.registerTool({
    name: "screenshot-tab",
    label: "Screenshot Tab",
    description:
      "Take a screenshot of the browser viewport. Returns the image as an attachment.",
    parameters: Type.Object({
      tab: Type.Optional(
        Type.Number({ description: "Tab index (default: 0)" }),
      ),
    }),
    async execute(_id, params) {
      try {
        const tabs = await listTabs();
        const tab = tabs[params.tab ?? 0];
        if (!tab) {
          return {
            content: [{ type: "text", text: "No tab at that index" }],
            isError: true,
          };
        }

        const scrollPos = await evalInTab(
          tab,
          `JSON.stringify({ x: window.scrollX, y: window.scrollY, w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })`,
        );
        const vp = JSON.parse(scrollPos);
        return await captureScreenshot(tab, vp.x, vp.y, vp.w, vp.h);
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "screenshot-element-in-tab",
    label: "Screenshot Element",
    description:
      "Take a screenshot of a specific DOM element by CSS selector. Returns the image as an attachment.",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector of the element to screenshot",
      }),
      tab: Type.Optional(
        Type.Number({ description: "Tab index (default: 0)" }),
      ),
    }),
    async execute(_id, params) {
      try {
        const tabs = await listTabs();
        const tab = tabs[params.tab ?? 0];
        if (!tab) {
          return {
            content: [{ type: "text", text: "No tab at that index" }],
            isError: true,
          };
        }

        const boundsJson = await evalInTab(
          tab,
          `(() => {
            const el = document.querySelector(${JSON.stringify(params.selector)});
            if (!el) return "null";
            el.scrollIntoView({ block: "center" });
            const r = el.getBoundingClientRect();
            return JSON.stringify({ x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height });
          })()`,
        );
        const bounds = JSON.parse(boundsJson);
        if (!bounds) {
          return {
            content: [
              {
                type: "text",
                text: `No element found for selector: ${params.selector}`,
              },
            ],
            isError: true,
          };
        }
        await new Promise((r) => setTimeout(r, 300));
        // Re-read after scroll settles
        const settled = await evalInTab(
          tab,
          `(() => {
            const el = document.querySelector(${JSON.stringify(params.selector)});
            const r = el.getBoundingClientRect();
            return JSON.stringify({ x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height });
          })()`,
        );
        const s = JSON.parse(settled);
        return await captureScreenshot(tab, s.x, s.y, s.w, s.h);
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "close-browser",
    label: "Close Firefox",
    description: "Kill the Firefox process and clean up the connection.",
    parameters: Type.Object({}),
    async execute() {
      if (!firefoxProcess) {
        return { content: [{ type: "text", text: "Firefox not running" }] };
      }
      cleanup();
      return { content: [{ type: "text", text: "Firefox closed" }] };
    },
  });
}
