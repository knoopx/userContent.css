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

`rules/<domain>.txt` contains uBlock Origin filter rules for JS scriptlets and advanced filtering that CSS cannot handle. Trivial element hiding belongs in `styles/` as `display: none` rules. Each file is named by domain and contains one filter per line.

## Palette

`palette.json` defines a base16 color scheme. Styles reference these as CSS variables (`--base00` through `--base0F`). The extension injects palette variables as a `:root` block before site styles.

## Style Files

Each file in `styles/` is named `<domain>.css` and matched to tabs by hostname. Styles override site CSS variables to apply the palette. The extension adds `!important` to all declarations before injection.

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
| `screenshot-tab`                     | Screenshot the tab viewport or a specific element.                                |
| `close-tab`                          | Close a tab by index.                                                             |
| `reload-tab`                         | Reload a tab.                                                                     |
| `close-browser`                      | Kill Firefox and clean up.                                                        |

## Workflow

1. `launch-browser` with a target URL
2. `extract-css-vars-from-stylesheets` (tab mode) to discover the site's CSS variables
3. Create/edit `styles/<domain>.css` mapping site variables to `--baseXX` palette values
4. `inject-styles-into-tab` to apply styles
5. `screenshot-tab` to verify results
6. Iterate on the CSS and re-inject

## Style Conventions

- Map site CSS variables to palette variables (`var(--base00)` through `var(--base0F)`). Do not use hardcoded colors.
- Domain matching uses hostname: `styles/slack.com.css` matches `slack.com` and `*.slack.com`.
- All injected rules get `!important` automatically.
- Use `color-mix(in srgb, var(--baseXX) <percent>%, transparent)` for semi-transparent variants.
- Target `:root` selector. Do not add theme-specific selectors (`.night`, `.dark`, `.theme-dark`) — the palette applies uniformly.
- Use `extract-css-vars-from-stylesheets` with `selector` filter (e.g. `.component-theme-dark`) to discover per-theme variables. Map both light and dark variants to the same palette values.

## Extension Internals

- `evalInTab` and `evalInChrome` both resolve Firefox RDP `longString` grips via `resolveGrip` to fetch the full result.
- CSS rule iteration must handle modern CSS nesting: `CSSStyleRule` objects have both `.cssRules` and `.style`. Do not `continue` after recursing into `.cssRules` — always process `.style` on every rule that has it.

## Dependencies

- **bun** — runtime
- **postcss** — CSS processing (custom plugin adds `!important` to all declarations)
