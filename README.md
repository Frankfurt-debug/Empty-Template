<div align="center">
  <h1>Interstellar (WebSocket edition)</h1>
  <p>A fork of <a href="https://github.com/UseInterstellar/Interstellar">UseInterstellar/Interstellar</a> where the whole frontend is <strong>one HTML file</strong> that connects to the proxy server over a <strong>WebSocket</strong>.</p>
</div>

Open `client/interstellar.html` from your disk, from a USB stick, from GitHub Pages, from anywhere. Point it at a running server and you get the full Interstellar experience: search bar, games, apps, tabbed browsing, inspect element, tab cloaking, about:blank cloaking, themes, panic key, save import/export, and all three proxy engines (Scramjet, Ultraviolet, Dynamic).

## How it works

```
┌──────────────────────────────┐        control WebSocket (/ws)         ┌──────────────────────────────┐
│  client/interstellar.html    │ ─────────────────────────────────────▶ │  Node server (index.js)       │
│  file:// or any static host  │  hello · auth · list apps/games ·      │  express + ws + wisp + bare   │
│                              │  resolve URL · ping                    │                              │
│  ┌────────────────────────┐  │                                        │  /frame  ← frame shell        │
│  │ <iframe> per tab       │◀─┼──── postMessage bridge ───────────────▶│  /sw.js  ← Scramjet/UV worker │
│  │ src = server/frame     │  │  navigate · back · forward · reload ·  │  /wisp/  ← transport socket   │
│  │  └ <iframe> proxied    │  │  inspect · title/url · window.open     │  /ca/    ← bare server        │
│  └────────────────────────┘  │                                        │  /e/     ← game assets        │
└──────────────────────────────┘                                        └──────────────────────────────┘
```

- **The HTML file is pure UI.** It has no dependency on the server's static pages. Its only link to the server is the control WebSocket at `/ws` and the frames it embeds.
- **The control WebSocket** (`/ws`) is a small JSON request/response protocol: `hello`, `auth`, `list` (apps or games), `resolve` (turn typed text into a URL using the chosen search engine), `ping`. It also carries password authentication and returns a session token.
- **Proxied pages need a service worker**, and a service worker can only be registered by a page on the server's own origin. So each tab embeds `server/frame`, a tiny "frame shell" page on the server that registers the worker, wires the bare-mux transport to the wisp WebSocket, and hosts the proxied page in an inner frame. The HTML client drives it with `postMessage`, which is how back/forward/reload/inspect-element/tab-titles keep working exactly like upstream even though the UI lives on another origin.
- **The proxy transport itself is a WebSocket too** (wisp), the same one upstream Interstellar uses.

Everything from upstream is still there: the classic multi-page UI is served at `/legacy`, `/a`, `/b`, `/c`, `/d` and the proxy engines, game assets, and asset cache are untouched.

## Quick start

```bash
git clone -b claude/interstellar-websocket-html-vwqd4z https://github.com/frankfurt-debug/empty-template interstellar
cd interstellar
npm install
npm start          # http://localhost:8080
```

Then either:

1. Open `http://localhost:8080/` in a browser (the server serves the same HTML file at `/`), or
2. Open `client/interstellar.html` straight from your disk. On first load it asks for the server address: enter `http://localhost:8080`.

You can also pass the server in the URL (`interstellar.html?server=https://my-proxy.example.com`) or download the file from any running server at `/client.html?download`.

### Running the HTML file somewhere else

| Where the HTML file is opened | Server address must be | Notes |
| --- | --- | --- |
| `file://` (double-clicked from disk) | `http://localhost:…` or `https://…` | Works in Chrome/Edge/Firefox. Origin is `null`, keep `null` or `*` in `ALLOWED_ORIGINS`. |
| GitHub Pages / Netlify / any `https://` static host | `https://…` only | Browsers block insecure `ws://` from secure pages. |
| Served by the proxy server itself (`/`) | same origin, auto-detected | Most compatible option in every browser. |

The proxy engine runs inside an embedded frame from another site, which some browsers restrict (Safari, Firefox "strict" tracking protection, Chrome with third-party cookies blocked). The frame then shows an **Open in a new tab** button, and the toolbar's pop-out button opens the page in an about:blank window. Loading the client from the server's own address avoids the restriction entirely.

## Appearance, and what it does not hide

Settings → **Appearance** sets the name shown in the header and on the home screen (default "Home"), and the line under the title is off by default. The header icon is shown only when you pick one in the Tab Cloaker, so the default header is just a name. Nothing in the interface advertises what it is.

That covers someone glancing at your screen. It does not make the traffic anonymous, and it is worth being clear about what still identifies this as a proxy:

- The browser's own address bar shows your server's domain, and the path contains the destination — Scramjet uses `/a/sj/https%3A%2F%2Fexample.com%2F`, which is plain percent-encoding, not obfuscation.
- Every request in the session resolves to your one host. DNS lookups, TLS SNI and any network log show your domain and never the sites themselves. That is exactly how the filter is bypassed and exactly how a network monitor recognises it.
- Sites see the server's IP address, not yours. Datacenter IP ranges get flagged: expect CAPTCHAs, "unusual sign-in location" mail, and outright blocks from Cloudflare-protected and Google properties.
- Inside a proxied page, Scramjet leaves about sixteen `$scramjet*` properties on `window`, and a service worker is registered under `/a/`. Both are visible in devtools, and a site that cares to look can find them.

Scramjet does emulate the things a page checks casually: a page's own scripts see the real `location`, `document.domain` and `window.top === window.self`.

Use this on networks where you are allowed to.

## Site compatibility

Most sites work. The ones that do not usually fail for one of these reasons, and they are worth recognising before you go hunting for a bug:

- **Games needing `SharedArrayBuffer`.** Threaded Unity and Godot builds require the page to be cross-origin isolated, which needs COOP/COEP headers on the real site's own origin. Through any proxy `crossOriginIsolated` is `false` and `SharedArrayBuffer` is `undefined`, so those titles will not start. Nothing can be done about this short of the site cooperating.
- **Cloudflare and bot checks.** Requests arrive from the server's datacenter IP, which draws CAPTCHAs and outright 403s on protected sites.
- **Popups.** The frame is sandboxed without `allow-popups`, so a page cannot open real browser windows. `window.open` is intercepted and becomes a new tab in the client instead, including relative paths like `/game/xyz`, which is how most portals launch a game.

When something misbehaves, open the tab toolbar's inspect button and read the console inside the page — that is the fastest way to tell a blocked request apart from a rewriting bug.

## Password protection

Set `challenge: true` in `config.js`, or start with `CHALLENGE=true npm start` (upstream's `config=true npm start` works too). Users and passwords live in `config.js`; `PASSWORD=...` overrides the default user's password.

When protection is on:

- the HTML client asks for a username and password and receives a signed session token over the WebSocket;
- `/frame`, the wisp transport socket and the control socket all require that token (or the classic basic-auth login for the `/legacy` UI);
- engine files, icons and game assets stay public because they contain nothing secret and the service worker must fetch them without credentials.

Set `SESSION_SECRET` so tokens survive a restart.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. |
| `CHALLENGE` / `config` | `false` | Enable password protection. |
| `PASSWORD` | `password` | Password for the default `interstellar` user. |
| `SESSION_SECRET` | random per boot | HMAC secret for session tokens. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated page origins allowed to open `/ws`. Use `null` for `file://` pages and about:blank windows, e.g. `https://me.github.io,null`. |

See `.env.example`.

## Hosting

The **server** needs a real Node.js process with WebSocket support. That rules out serverless/static platforms for the backend: Vercel, Netlify, Cloudflare Pages, and GitHub Pages cannot run it (upstream's `vercel.json` has been removed for that reason). Those platforms *can* host the HTML file itself, pointed at a server hosted elsewhere.

The server also needs **HTTPS** in production. Service workers only run on `https://` (or `http://localhost`), and every host below gives you a TLS certificate automatically.

### Can I use Replit?

Technically yes: Replit runs Node.js and WebSockets, and a `.replit` file is included. Two caveats before you do:

- **Policy.** Replit's own help centre says that using Replit as a proxy to get around school or parental filters violates their terms, and that they shut such repls down both automatically and by hand. If that is your use case, expect it to be taken down. See [Replit's legal and security docs](https://docs.replit.com/category/legal-and-security).
- **Cost.** Replit stopped free always-on hosting in January 2024. A repl on the free plan only runs while you have the editor open; a stable URL needs a paid Deployment.

### Better options

| Host | Free tier | Notes |
| --- | --- | --- |
| [Render](https://render.com) | Yes, 750 instance-hours per month, sleeps after 15 min idle (about a minute to wake) | WebSockets work on the free instance. `render.yaml` is included; connect the repo and it deploys the Dockerfile. |
| [Koyeb](https://www.koyeb.com) | Yes, one free nano instance that scales to zero | Runs Node and WebSockets. Use the deploy button below or point a new service at this repo (Dockerfile is auto-detected). |
| [Railway](https://railway.com) | Trial credit, then usage-based (roughly $5/month for a small service) | WebSockets on all plans. Auto-detects the Dockerfile. |
| [Fly.io](https://fly.io) | Pay as you go, card required | `fly.toml` included: `fly launch --copy-config && fly deploy`. Scales to zero when idle. |
| [Heroku](https://heroku.com) | No (Eco dynos are about $5/month) | `app.json` included for the deploy button. |
| GitHub Codespaces | 120 core-hours per month on a free personal account, which is 60 hours on the default 2-core machine | Good for trying it out, not for permanent hosting: the codespace stops after 30 minutes of inactivity. See below. |
| Any VPS (Oracle Cloud Always Free, Hetzner, DigitalOcean, a Raspberry Pi at home) | Depends | `docker build -t interstellar . && docker run -p 8080:8080 interstellar`, put Caddy or a Cloudflare Tunnel in front for HTTPS. |

<a target="_blank" href="https://render.com/deploy?repo=https://github.com/frankfurt-debug/empty-template"><img alt="Deploy to Render" src="https://render.com/images/deploy-to-render-button.svg" height="32"></a>
<a target="_blank" href="https://app.koyeb.com/deploy?type=git&repository=github.com/frankfurt-debug/empty-template&branch=claude/interstellar-websocket-html-vwqd4z"><img alt="Deploy to Koyeb" src="https://www.koyeb.com/static/images/deploy/button.svg" height="32"></a>
<a target="_blank" href="https://heroku.com/deploy/?template=https://github.com/frankfurt-debug/empty-template"><img alt="Deploy to Heroku" src="https://www.herokucdn.com/deploy/button.svg" height="32"></a>

Hosts that have shut down or no longer suit this: Glitch ended app hosting in 2025, Cyclic closed in 2024, and Vercel/Netlify functions cannot hold a WebSocket open.

### Running on GitHub Codespaces

Codespaces gives you a Node process and an HTTPS URL for free, which is everything this server needs. The one step you cannot skip is making the forwarded port **public**.

1. **Create the codespace on this branch.** On the repository page click **Code → Codespaces → ⋯ → New with options…**, set Branch to `claude/interstellar-websocket-html-vwqd4z`, and create it. (Creating one straight from the green button uses the default branch instead.)
2. **Start the server** in the codespace terminal:

   ```bash
   npm install
   npm start
   ```

   The `PORT` variable is already set by the platform where it matters; locally it defaults to 8080.
3. **Make the port public.** Open the **Ports** tab next to the terminal, right-click port 8080, and choose **Port Visibility → Public**.

   This is required, not optional. A private forwarded port demands a GitHub token on every request, so the service worker, the frame shell and the WebSocket all fail with 401s and the client just shows "Offline". If the Ports tab is empty, or the URL 404s on first boot, toggling visibility off and on refreshes the forwarding.
4. **Open the URL**, which looks like `https://<codespace-name>-8080.app.github.dev`. That serves the same single-file client, and because GitHub terminates TLS for you the service worker requirement is satisfied.

To use the HTML file from your own machine instead, open `client/interstellar.html` and paste that `https://…app.github.dev` address into the connect dialog. Both work; loading it from the codespace URL is the more browser-compatible of the two.

Two things worth knowing:

- **A public port is genuinely public.** Anyone who has the URL can use your proxy while the codespace is running. If that matters, turn on password protection: `CHALLENGE=true PASSWORD=something-long npm start`.
- **The codespace stops after 30 minutes of inactivity** (default, adjustable in your Codespaces settings), and the URL changes each time you create a new one. Use one of the always-on hosts above if you want a stable address.

Whatever you pick, check the host's acceptable-use policy. Several platforms treat web proxies and "unblockers" as prohibited content and will remove them.

## Project layout

| Path | What it is |
| --- | --- |
| `client/interstellar.html` | The standalone frontend. Single file, no build step, no CDN dependencies. Also served at `/` and `/client.html`. |
| `static/frame.html` | The frame shell served at `/frame`: registers the service worker, sets up the transport, hosts one proxied page, exposes the postMessage API. |
| `index.js` | Upstream server plus the `/ws` control socket, `/frame` route, token auth and origin policy. |
| `config.js` | Password protection settings (also driven by env). |
| `static/` | Upstream's classic UI, proxy engine bundles, icons, game/app lists. |

### Control socket protocol

Every request is `{ "id": "...", "type": "...", ...fields }` and every reply is `{ "id": "...", "ok": true, ...data }` or `{ "id": "...", "ok": false, "error": "...", "code": "..." }`. The server sends `{ "type": "hello", ... }` on connect.

| Type | Fields | Reply |
| --- | --- | --- |
| `hello` | | server name, version, `challenge`, engines, search engines, `frame` path |
| `auth` | `username`+`password` or `token` | `token`, `user` |
| `list` | `kind`: `apps` or `games` | `items` (same JSON as upstream's `a.json`/`g.json`) |
| `resolve` | `input`, `engine` (name or URL) | `url` |
| `ping` | | `pong`, `time` |

## Credits and license

All proxy engines, the classic UI, icons, and the app/game catalogue come from [Interstellar](https://github.com/UseInterstellar/Interstellar) and its contributors. This fork keeps their GPL-3.0-or-later license (see `LICENSE`). If you use this, consider starring the original repository.
