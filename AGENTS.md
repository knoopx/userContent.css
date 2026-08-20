# AGENTS.md

Custom CSS themes for websites, applied via a pi extension that controls Firefox through its Remote Debugging Protocol.

## Project Structure

```
palette.json                  # Base16 color palette (--base00 through --base0F)
styles/<domain>.css           # Per-site stylesheets
rules/<domain>.txt            # uBlock Origin filter rules
.pi/extensions/firefox-rdp.ts  # Pi extension: Firefox automation tools
```

## uBlock Rules

`rules/<domain>.txt` holds uBlock Origin filter rules, one filter per line, named by domain. Two kinds of filters live here:

- **Advanced filtering / scriptlets** — behavior CSS cannot express: `+js(...)` scriptlets, `:style()`, `:remove-attr()`, request blocking, and other uBlock advanced-filter syntax.
- **Element hiding** — `##selector` rules. Use these when hiding should be owned by uBlock rather than the CSS-injecting extension (for example lazy-rendered elements that only exist while a prompt is open, or hiding that must not depend on the extension being active).

Ordinary, always-present element hiding goes in `styles/<domain>.css` as a `display: none` rule; keep `##` hiding in `rules/` for the cases above. uBlock hiding is cosmetic only — it removes the visual but cannot stop the underlying JS runtime behavior (e.g. a hidden YouTube idle prompt still pauses the video).

## Palette

`palette.json` defines a base16 color scheme. Styles reference these as CSS variables (`--base00` through `--base0F`). The extension injects palette variables as a `:root` block before site styles.

## Style Files

Each file in `styles/` is named `<domain>.css` and matched to tabs by hostname. Styles override site CSS variables to apply the palette. The extension adds `!important` to all declarations before injection.

### Multi-page Coverage

Style files must cover all relevant pages of a site, not just the homepage.

- When a site uses the same CSS variables across all pages (most do), a `:root`-level variable mapping covers everything automatically.
- When a site has page-specific hardcoded colors (e.g. a product detail page with different accent colors, a dashboard with chart-specific variables), identify and handle those too.
- Use `navigate-tab-to-url` to visit subpages (product pages, search results, dashboards, detail views), then `extract-css-vars-from-stylesheets` on each to find additional variables not covered by the `:root` mapping.
- Verify the theme on at least 2–3 different page types before considering a style file complete.

## Extension Tools

The extension (`.pi/extensions/firefox-rdp.ts`) registers these tools:

| Tool                                 | Purpose                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `launch-browser`                     | Launch Firefox with RDP enabled. Call first.                                      |
| `list-browser-tabs`                  | List open tabs with URLs.                                                         |
| `inject-styles-into-tab`             | Inject palette + matching styles into tabs. Target by tab index or URL substring. |
| `navigate-tab-to-url`                | Navigate a tab to a URL.                                                          |
| `eval-js-expression-in-tab`          | Evaluate a JavaScript expression in a tab. For DOM inspection and debugging.      |
| `query-elements-by-selector`         | Query DOM elements by CSS selector. Returns tag, classes, computed styles, text.  |
| `get-computed-css-vars-from-element` | Get resolved CSS custom property values from an element.                          |
| `extract-css-vars-from-stylesheets`  | Extract CSS variable declarations from a local file or live page stylesheets.     |
| `screenshot-tab`                     | Screenshot the tab viewport.                                                      |
| `screenshot-element-in-tab`          | Screenshot a specific DOM element by CSS selector.                                |
| `close-tab`                          | Close a tab by index.                                                             |
| `reload-tab`                         | Reload a tab.                                                                     |
| `close-browser`                      | Kill Firefox and clean up.                                                        |

## Workflow

1. `launch-browser` with a target URL
2. `extract-css-vars-from-stylesheets` (tab mode) to discover the site's CSS variables
3. `navigate-tab-to-url` to subpages (product pages, search results, dashboards, detail views) and extract their CSS variables; handle any page-specific variables not covered by the `:root` mapping
4. Create/edit `styles/<domain>.css` mapping site variables to `--baseXX` palette values
5. `inject-styles-into-tab` to apply styles
6. `navigate-tab-to-url` back to a subpage, `inject-styles-into-tab`, and `screenshot-tab` to verify the theme applies correctly there
7. Iterate on the CSS and re-inject

## Style Conventions

- Map site CSS variables to palette variables (`var(--base00)` through `var(--base0F)`). Do not use hardcoded colors.
- Domain matching uses hostname: `styles/slack.com.css` matches `slack.com` and `*.slack.com`.
- All injected rules get `!important` automatically.
- Use `color-mix(in srgb, var(--baseXX) <percent>%, transparent)` for semi-transparent variants.
- Target `:root` selector. Do not add theme-specific selectors (`.night`, `.dark`, `.theme-dark`) — the palette applies uniformly.
- Use `extract-css-vars-from-stylesheets` with `selector` filter (e.g. `.component-theme-dark`) to discover per-theme variables. Map both light and dark variants to the same palette values.
- The project's primary accent is `--base0D` (#fad000 yellow). Map a site's main accent/CTA/interactive color to `var(--base0D)`, NOT `var(--base0C)`. Use `--base0C` only for secondary/tertiary accent roles (info, links in some contexts).
- Block ALL ads, banners, and promotional elements. Every style file must include `display: none` rules for ad containers, promotional banners, and sponsored content. Inspect the live page for ad slots before finalizing.
- Block ALL cookie popovers, consent banners, and modal popups. Use high-specificity selectors if the site re-asserts `display: block` (e.g. `html body div#cookie-banner.cookie-banner { display: none }`).
- Style ALL elements comprehensively. No white/unstyled boxes should remain. Scan for inline `style` attributes with hardcoded colors, SVG `fill`/`stroke` values, and shadow-DOM custom elements.
- Maintain consistent contrast between text and background. Light text (`var(--base05)`) on dark backgrounds (`var(--base00)`/`var(--base01)`). Dark text (`var(--base00)`) on accent fills (`var(--base0D)`). Never pair similar-luminance colors.
- The primary accent color is `--base0D` (yellow #fad000). Map a site's main accent/CTA/interactive color to `var(--base0D)`. Use `--base0C` only for secondary/tertiary roles.
- Block ALL ads, banners, promotional elements, and cookie/consent popovers. Use `display: none` on the container AND collapse the occupied space (`height: 0; overflow: hidden; margin: 0; padding: 0; border: none`) so the layout does not leave gaps.
- Style ALL elements comprehensively. No white/unstyled boxes. Scan for inline styles, SVG fills/strokes, and shadow-DOM custom elements.
- Maintain consistent contrast: light text (`--base05`) on dark backgrounds (`--base00`/`--base01`), dark text (`--base00`) on accent fills (`--base0D`). Never pair similar-luminance colors.
- When a site locks scrolling (inline `overflow: hidden` on `body` or a scroll-trap modal), override with `body, html { overflow: auto }` in the style file. When a site suppresses right-click (contextmenu), add a uBlock scriptlet to the `rules/<domain>.txt` file: `+js(setInterval(() => { document.oncontextmenu = null; }, 100))` or use the existing `##*#style(body { overflow: auto })` pattern if applicable.
- ALWAYS screenshot to validate changes. After every edit or re-injection, take a screenshot of the affected page and visually confirm the theme is applied correctly before proceeding. No change is verified without a screenshot.
- NEVER use `sleep` or artificial delays. All operations are synchronous or use `eval-js-expression-in-tab` polling. No waiting.
- If a site requires authentication, ask the user to log in via the browser. Do NOT refresh the page after login — use `inject-styles-into-tab` to apply the theme. Only use `reload-tab` to clear back to original unstyled state.
- Use `inject-styles-into-tab` to apply or re-apply styles after edits. Never reload the page to pick up CSS changes — just re-inject.

## Extension Internals

- `evalInTab` and `evalInChrome` both resolve Firefox RDP `longString` grips via `resolveGrip` to fetch the full result.
- CSS rule iteration must handle modern CSS nesting: `CSSStyleRule` objects have both `.cssRules` and `.style`. Do not `continue` after recursing into `.cssRules` — always process `.style` on every rule that has it.

## Dependencies

- **bun** — runtime
- **postcss** — CSS processing (custom plugin adds `!important` to all declarations)
