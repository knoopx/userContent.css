# AGENTS.md

Custom CSS themes for websites, applied by injecting palette + per-site stylesheets into a running Firefox controlled by the **bruvtab** CLI (a native-messaging "mediator" add-on in Firefox exposes its tabs over a local TCP API).

## Prerequisites

- `bruvtab` on PATH (nix package).
- Firefox running with the bruvtab mediator add-on installed (`bruvtab install --browser firefox`). Confirm a client is registered with `bruvtab clients` (a row like `a. localhost:4625 <pid> firefox`).
- **`eval` support**: style injection, DOM queries, computed-var reads, and stylesheet extraction all go through `bruvtab eval`. The mediator add-on must be a version whose XPI implements the `eval` command (older XPIs reject it with `Unknown command: eval`). If `bruvtab eval "1+1"` does not return `2`, the installed add-on predates `eval` — update bruvtab and restart Firefox.

## Project Structure

```
palette.json                  # Base16 color palette (--base00 through --base0F)
styles/<domain>.css           # Per-site stylesheets
rules/<domain>.txt            # uBlock Origin filter rules
scripts/inject-styles.mjs     # Palette + style injection (drives `bruvtab eval`)
```

## uBlock Rules

`rules/<domain>.txt` holds uBlock Origin filter rules, one filter per line, named by domain. Two kinds of filters live here:

- **Advanced filtering / scriptlets** — behavior CSS cannot express: `+js(...)` scriptlets, `:style()`, `:remove-attr()`, request blocking, and other uBlock advanced-filter syntax.
- **Element hiding** — `##selector` rules. Use these when hiding should be owned by uBlock rather than the CSS injection (for example lazy-rendered elements that only exist while a prompt is open, or hiding that must not depend on the injection running).

Ordinary, always-present element hiding goes in `styles/<domain>.css` as a `display: none` rule; keep `##` hiding in `rules/` for the cases above. uBlock hiding is cosmetic only — it removes the visual but cannot stop the underlying JS runtime behavior (e.g. a hidden YouTube idle prompt still pauses the video).

## Palette

`palette.json` defines a base16 color scheme. Styles reference these as CSS variables (`--base00` through `--base0F`). `scripts/inject-styles.mjs` expands each palette entry into `:root` variables — `--baseXX`, `--baseXX-rgb`, `--baseXX-hsl`, `--baseXX-oklch` — and injects that block before the site styles.

## Style Files

Each file in `styles/` is named `<domain>.css` and matched to tabs by hostname. Styles override site CSS variables to apply the palette. `scripts/inject-styles.mjs` adds `!important` to every declaration before injection.

### Multi-page Coverage

Style files must cover all relevant pages of a site, not just the homepage.

- When a site uses the same CSS variables across all pages (most do), a `:root`-level variable mapping covers everything automatically.
- When a site has page-specific hardcoded colors (e.g. a product detail page with different accent colors, a dashboard with chart-specific variables), identify and handle those too.
- Use `bruvtab navigate <tab> <subpage-url>` to visit subpages (product pages, search results, dashboards, detail views), then run the stylesheet-extraction snippet (below) on each to find additional variables not covered by the `:root` mapping.
- Verify the theme on at least 2–3 different page types before considering a style file complete.

## bruvtab Commands

Tab IDs have the form `<prefix>.<window>.<tab>` (e.g. `a.1.1`); get them from `bruvtab list`. Most commands accept a tab ID, title, or URL fragment to target a specific tab.

| Command | Purpose |
| --- | --- |
| `bruvtab list` | List open tabs: `<tab_id>\t<title>\t<URL>`. |
| `bruvtab open <url> [tab]` | Open a URL in a new (or given) tab. |
| `bruvtab navigate <tab> <url>` | Navigate a tab to a URL. |
| `bruvtab close <tab>` | Close a tab. |
| `bruvtab activate <tab>` | Focus a tab. |
| `bruvtab active` | Show the active tab per window. |
| `bruvtab screenshot [tab]` | Base64 PNG of the (visible) tab as JSON `{data, tab, window, api}`. |
| `bruvtab eval <expr> [tab]` | Evaluate a JS expression in a tab, print the result to stdout. |
| `bruvtab words\|text\|html [tab]` | Dump sorted words / text / HTML of tabs. |
| `bruvtab query` | Filter tabs via the browser tabs API. |
| `bruvtab windows` / `bruvtab clients` | Inspect windows and connected mediators. |

## Style Injection

`node scripts/inject-styles.mjs [tab]` loads `palette.json` + every `styles/*.css`, domain-matches the styles to each target tab's URL, adds `!important` to all declarations (postcss), and injects the result into the tab's CSSOM via `bruvtab eval` (a `#__usercss__` `<style>` element, re-created on each run so re-injection is idempotent).

- No argument: inject into **every** tab that has a matching style; tabs with no match are reported as `skip`.
- With a tab argument (ID / title / URL fragment): inject into just that tab.

## JS `eval` Snippets

The old per-tool DOM helpers are now `bruvtab eval` one-liners. Tab ID last.

- **Query elements by selector** (tag, classes, computed style, text):
  `bruvtab eval "JSON.stringify([...document.querySelectorAll('SELECTOR')].slice(0,10).map(e=>({tag:e.tagName,cls:e.className,inline:e.getAttribute('style'),color:getComputedStyle(e).color,text:e.textContent?.slice(0,120)})))" <tab>`
- **Read computed CSS variables** from an element (default `:root`):
  `bruvtab eval "JSON.stringify(Object.fromEntries(['--var-a','--var-b'].map(v=>[v,getComputedStyle(document.querySelector(':root')).getPropertyValue(v).trim()])))" <tab>`
- **Extract color CSS-variable declarations from live stylesheets** (name + value, hardcoded colors only):
  `bruvtab eval "(()=>{const out=[];for(const s of document.styleSheets){try{for(const r of s.cssRules){if(!r.style)continue;for(let i=0;i<r.style.length;i++){const p=r.style[i];if(p.startsWith('--')){const v=r.style.getPropertyValue(p).trim();if(/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|color\()/i.test(v))out.push(r.selectorText+' '+p+': '+v);}}}}catch(e){}}return JSON.stringify(out);})()" <tab>`

## Workflow

1. `bruvtab open <target-url>` (or `bruvtab list` if the tab is already open).
2. Run the stylesheet-extraction snippet to discover the site's CSS variables.
3. `bruvtab navigate <tab> <subpage-url>` to subpages and re-extract; handle any page-specific variables not covered by the `:root` mapping.
4. Create/edit `styles/<domain>.css` mapping site variables to `--baseXX` palette values.
5. `node scripts/inject-styles.mjs <tab>` to apply the styles.
6. `bruvtab navigate <tab> <subpage>`, re-inject, and `bruvtab screenshot <tab>` to verify the theme applies there.
7. Iterate on the CSS and re-inject.

## Style Conventions

- Map site CSS variables to palette variables (`var(--base00)` through `var(--base0F)`). Do not use hardcoded colors.
- Domain matching uses hostname: `styles/slack.com.css` matches `slack.com` and `*.slack.com`.
- All injected rules get `!important` automatically.
- Use `color-mix(in srgb, var(--baseXX) <percent>%, transparent)` for semi-transparent variants.
- Target `:root` selector. Do not add theme-specific selectors (`.night`, `.dark`, `.theme-dark`) — the palette applies uniformly.
- Use the stylesheet-extraction snippet (with a selector filter, e.g. `.component-theme-dark`) to discover per-theme variables. Map both light and dark variants to the same palette values.
- The project's primary accent is `--base0D` (#fad000 yellow). Map a site's main accent/CTA/interactive color to `var(--base0D)`, NOT `var(--base0C)`. Use `--base0C` only for secondary/tertiary accent roles (info, links in some contexts).
- Block ALL ads, banners, and promotional elements. Every style file must include `display: none` rules for ad containers, promotional banners, and sponsored content. Inspect the live page for ad slots before finalizing.
- Block ALL cookie popovers, consent banners, and modal popups. Use high-specificity selectors if the site re-asserts `display: block` (e.g. `html body div#cookie-banner.cookie-banner { display: none }`).
- Style ALL elements comprehensively. No white/unstyled boxes should remain. Scan for inline `style` attributes with hardcoded colors, SVG `fill`/`stroke` values, and shadow-DOM custom elements.
- Maintain consistent contrast between text and background. Light text (`var(--base05)`) on dark backgrounds (`var(--base00)`/`var(--base01)`). Dark text (`var(--base00)`) on accent fills (`var(--base0D)`). Never pair similar-luminance colors.
- Block ALL ads, banners, promotional elements, and cookie/consent popovers. Use `display: none` on the container AND collapse the occupied space (`height: 0; overflow: hidden; margin: 0; padding: 0; border: none`) so the layout does not leave gaps.
- When a site locks scrolling (inline `overflow: hidden` on `body` or a scroll-trap modal), override with `body, html { overflow: auto }` in the style file. When a site suppresses right-click (contextmenu), add a uBlock scriptlet to the `rules/<domain>.txt` file: `+js(setInterval(() => { document.oncontextmenu = null; }, 100))` or use the existing `##*#style(body { overflow: auto })` pattern if applicable.
- ALWAYS screenshot to validate changes. After every edit or re-injection, take a screenshot (`bruvtab screenshot <tab>`) and visually confirm the theme is applied correctly before proceeding. No change is verified without a screenshot.
- NEVER use `sleep` or artificial delays. Operations are synchronous; poll with `bruvtab eval` if a value is not ready. No waiting.
- If a site requires authentication, ask the user to log in via the browser. Do NOT reload the page after login — re-run `node scripts/inject-styles.mjs <tab>` to apply the theme. Only reload (`bruvtab navigate <tab> <url>` to the same URL, or `bruvtab eval "location.reload()" <tab>`) to clear back to the original unstyled state.
- Re-inject to apply or re-apply styles after edits. Never reload the page to pick up CSS changes — just re-run the injection script.

## Injection Internals

- `scripts/inject-styles.mjs` shells out to `bruvtab` via `execFileSync`; the CSSOM snippet is passed as a single `bruvtab eval` argument, so very large style sets are fine (well within `ARG_MAX`).
- The snippet re-creates the `#__usercss__` element each run (removing any prior one), making injection idempotent.
- postcss splits the combined CSS into top-level rules; each is inserted via `CSSStyleSheet.insertRule`. Modern CSS nesting is preserved because postcss serializes nested rules and current browser CSSOM accepts nested `insertRule`.

## Dependencies

- **node** — runtime for `scripts/inject-styles.mjs`.
- **postcss** — CSS processing (custom plugin adds `!important` to all declarations).
- **bruvtab** — browser automation CLI (nix package); requires an `eval`-capable Firefox mediator add-on.
