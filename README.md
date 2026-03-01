# userContent.css

Base16 color themes and uBlock Origin filter rules for websites, delivered as a Firefox `userContent.css` and a combined rules file.

## How it works

Per-site CSS files in `styles/` remap each site's CSS variables to a shared base16 palette defined in `palette.json`. A build step wraps them in `@-moz-document` rules, adds `!important` to all declarations, and outputs a single `userContent.css` for Firefox.

## Install

The flake exports `lib.<system>.mkUserStyles` and `lib.<system>.uBlockRules`:

```nix
# In your flake:
usercss.url = "github:knoopx/userContent.css";

# Build userContent.css with your palette:
usercss.lib.${system}.mkUserStyles {
  base00 = "#1d2021";
  base01 = "#3c3836";
  # ...
}

# Combined uBlock Origin rules:
usercss.lib.${system}.uBlockRules
```

## Palette

`palette.json` defines 16 colors (`--base00` through `--base0F`). All site styles reference these variables — change the palette to retheme every site at once.

## Styles

Each file in `styles/` is named `<domain>.css` and targets `:root`. Rules:

- Use only `var(--base00)` through `var(--base0F)`. No hardcoded colors.
- No theme-specific selectors (`.dark`, `.night`, etc.).
- Use `color-mix(in srgb, var(--baseXX) <percent>%, transparent)` for transparency.
- `!important` is added automatically at build time.

## uBlock rules

`rules/` contains per-site uBlock Origin filter rules for JS scriptlets and advanced filtering that CSS cannot handle. Trivial element hiding belongs in `styles/` as `display: none` rules.

## Adding a new site

Requires [pi](https://github.com/mariozechner/pi-coding-agent). From the project directory:

1. Run `pi` to start the agent
2. Ask it to style a website, e.g. "style github.com"
3. Pi will launch Firefox, navigate to the site, extract its CSS variables, create `styles/<domain>.css` mapping them to the palette, inject it for live preview, and take a screenshot
4. Review the screenshot and ask for adjustments ("make the sidebar darker", "fix the link colors")
5. Pi re-edits the CSS, re-injects, and screenshots again
6. Repeat until satisfied

## Development

Install dependencies:

```sh
npm install
```

## Dependencies

- [postcss](https://postcss.org) — CSS processing
