Generate screenshots for all styled sites into `screenshots/`.

## Steps

1. `launch-browser` with any URL
2. For each `.css` file in `styles/`:
   - Skip sites that require authentication (discord.com, slack.com, web.telegram.org, web.whatsapp.com, mail.google.com, open.spotify.com) and private instances (home.knoopx.net, llm.knoopx.net)
   - Navigate to a representative **project or detail page** (not a landing/home page). Examples:
     - github.com → a popular repo (e.g. `github.com/denoland/deno`)
     - crates.io → a crate page (e.g. `crates.io/crates/serde`)
     - pypi.org → a project page (e.g. `pypi.org/project/requests/`)
     - stackoverflow.com → a question page
     - wikipedia.org → an article (e.g. `en.wikipedia.org/wiki/Linux`)
     - reddit.com → a subreddit (e.g. `reddit.com/r/NixOS/`)
     - news.ycombinator.com, lobste.rs → front page (list pages by nature)
     - duckduckgo.com, qwant.com → search results page
     - search.nixos.org → search with a query
   - `inject-styles-into-tab`
   - `screenshot-tab` with `savePath: screenshots/<domain>.png`
3. Verify all files are unique with `md5sum screenshots/*.png`
