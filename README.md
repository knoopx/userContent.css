# usercss

Base16 color themes for websites, injected via Firefox Remote Debugging Protocol.

## How it works

A [pi](https://github.com/mariozechner/pi-coding-agent) extension controls Firefox over RDP to inject per-site CSS that remaps each site's CSS variables to a shared base16 palette.

## Palette

`palette.json` defines 16 colors (`--base00` through `--base0F`). All site styles reference these variables — change the palette to retheme every site at once.

## Adding a new site

1. Launch Firefox: `launch-browser` with the target URL
2. Extract the site's CSS variables: `extract-css-vars-from-stylesheets` (tab mode)
3. Create `styles/<domain>.css` mapping site variables to `var(--baseXX)` palette values
4. Inject and verify: `inject-styles-into-tab`, then `screenshot-tab`
5. Iterate until it looks right

## uBlock rules

`rules/` contains per-site uBlock Origin filter rules for JS scriptlets and advanced filtering that CSS cannot handle. Trivial element hiding belongs in `styles/` as `display: none` rules.

## Style rules

- Use only `var(--base00)` through `var(--base0F)`. No hardcoded colors.
- Target `:root`. No theme-specific selectors.
- Use `color-mix(in srgb, var(--baseXX) <percent>%, transparent)` for transparency.
- `!important` is added automatically during injection.

## Install

The flake exports `lib.<system>.mkUserStyles`, which takes a palette attrset and produces a `userContent.css` file:

```nix
# In your flake:
usercss.url = "github:knoopx/userContent.css";

# Build userContent.css with a palette:
usercss.lib.${system}.mkUserStyles {
  base00 = "#1d2021";
  base01 = "#3c3836";
  # ...
}

# Combined uBlock Origin rules:
usercss.lib.${system}.uBlockRules
```

For development, install npm dependencies with:

```sh
npm install
```

## Dependencies

- [postcss](https://postcss.org) — CSS processing
