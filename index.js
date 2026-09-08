import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import bareMuxNode from "@mercuryworkshop/bare-mux/node";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import { createBareServer } from "@nebula-services/bare-server-node";
import chalk from "chalk";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import basicAuth from "express-basic-auth";
import mime from "mime";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
// import { setupMasqr } from "./Masqr.js";
import config from "./config.js";

console.log(chalk.yellow("🚀 Starting server..."));

const __dirname = process.cwd();
const server = http.createServer();
const app = express();
const bareServer = createBareServer("/ca/");
const { baremuxPath } = bareMuxNode;
const epoxyDistPath = path.join(__dirname, "node_modules", "@mercuryworkshop", "epoxy-transport", "dist");
const PORT = process.env.PORT || 8080;
const cache = new Map();
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // Cache for 30 Days
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

wisp.options.allow_loopback_ips = true;
wisp.options.allow_private_ips = true;

/* ------------------------------------------------------------------ */
/*  Auth helpers (shared by the classic UI, the /frame shell, /ws and  */
/*  the wisp transport socket)                                         */
/* ------------------------------------------------------------------ */

const challengeEnabled = config.challenge !== false;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const TOKEN_COOKIE = "is_token";
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;

// Engine code, icons and game assets are always public: they contain nothing
// secret, and a standalone client on another origin (or the service worker)
// must be able to fetch them without credentials. Password protection gates
// the UI pages, the control socket and the proxy transport itself.
const PUBLIC_PREFIXES = ["/sw.js", "/assets", "/e", "/bm", "/ep", "/client.html", "/favicon.ico", "/favicon.png"];

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function makeToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, t: Date.now() })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (expected.length !== signature.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.u || !(data.u in config.users)) return null;
    if (Date.now() - data.t > TOKEN_TTL) return null;
    return data.u;
  } catch {
    return null;
  }
}

function checkCredentials(username, password) {
  if (typeof username !== "string" || typeof password !== "string") return false;
  const expected = config.users[username];
  if (typeof expected !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Works for both express requests and raw upgrade requests.
function requestUser(req) {
  if (!challengeEnabled) return "anonymous";
  const url = new URL(req.url, "http://localhost");
  const fromQuery = verifyToken(url.searchParams.get("token"));
  if (fromQuery) return fromQuery;
  const cookies = req.cookies || parseCookies(req.headers.cookie);
  const fromCookie = verifyToken(cookies[TOKEN_COOKIE]);
  if (fromCookie) return fromCookie;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Basic ")) {
    const [user, ...rest] = Buffer.from(auth.slice(6), "base64").toString().split(":");
    if (checkCredentials(user, rest.join(":"))) return user;
  }
  return null;
}

function isSecure(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function cookieOptions(req) {
  const secure = isSecure(req);
  return {
    httpOnly: true,
    maxAge: TOKEN_TTL,
    path: "/",
    secure,
    // When the /frame shell is embedded by an HTML file on another origin
    // the cookie is third-party, so it must be SameSite=None + Partitioned.
    sameSite: secure ? "none" : "lax",
    partitioned: secure,
  };
}

function isPublicPath(p) {
  return PUBLIC_PREFIXES.some(prefix => p === prefix || p.startsWith(`${prefix}/`));
}

/* ------------------------------------------------------------------ */
/*  Origin policy for the control socket                               */
/* ------------------------------------------------------------------ */

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

function originAllowed(origin) {
  if (allowedOrigins.includes("*")) return true;
  // Browsers send "null" for file:// pages and about:blank windows.
  const value = origin || "null";
  return allowedOrigins.includes(value);
}

/* ------------------------------------------------------------------ */
/*  Express app                                                        */
/* ------------------------------------------------------------------ */

app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(cookieParser());

if (challengeEnabled) {
  console.log(chalk.green("🔒 Password protection is enabled! Listing logins below"));
  // biome-ignore lint: idk
  Object.entries(config.users).forEach(([username, password]) => {
    console.log(chalk.blue(`Username: ${username}, Password: ${password}`));
  });
  const basic = basicAuth({ users: config.users, challenge: true });
  app.use((req, res, next) => {
    if (isPublicPath(req.path) || req.path === "/frame") return next();
    const user = requestUser(req);
    if (user) {
      // Refresh the session cookie so same-origin websocket upgrades carry it.
      if (!verifyToken(req.cookies?.[TOKEN_COOKIE])) res.cookie(TOKEN_COOKIE, makeToken(user), cookieOptions(req));
      return next();
    }
    basic(req, res, err => {
      if (err) return next(err);
      if (req.auth?.user) res.cookie(TOKEN_COOKIE, makeToken(req.auth.user), cookieOptions(req));
      next();
    });
  });
}

app.get("/e/*", async (req, res, next) => {
  try {
    if (cache.has(req.path)) {
      const { data, contentType, timestamp } = cache.get(req.path);
      if (Date.now() - timestamp > CACHE_TTL) {
        cache.delete(req.path);
      } else {
        res.writeHead(200, { "Content-Type": contentType });
        return res.end(data);
      }
    }

    const baseUrls = {
      "/e/1/": "https://raw.githubusercontent.com/qrs/x/fixy/",
      "/e/2/": "https://raw.githubusercontent.com/3v1/V5-Assets/main/",
      "/e/3/": "https://raw.githubusercontent.com/3v1/V5-Retro/master/",
    };

    let reqTarget;
    for (const [prefix, baseUrl] of Object.entries(baseUrls)) {
      if (req.path.startsWith(prefix)) {
        reqTarget = baseUrl + req.path.slice(prefix.length);
        break;
      }
    }

    if (!reqTarget) {
      return next();
    }

    const asset = await fetch(reqTarget);
    if (!asset.ok) {
      return next();
    }

    const data = Buffer.from(await asset.arrayBuffer());
    const ext = path.extname(reqTarget);
    const no = [".unityweb"];
    const contentType = no.includes(ext) ? "application/octet-stream" : mime.getType(ext);

    cache.set(req.path, { data, contentType, timestamp: Date.now() });
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch (error) {
    console.error("Error fetching asset:", error);
    res.setHeader("Content-Type", "text/html");
    res.status(500).send("Error fetching the asset");
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* if (process.env.MASQR === "true") {
  console.log(chalk.green("Masqr is enabled"));
  setupMasqr(app);
} */

const transportStaticOptions = {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath);
    if (ext === ".mjs" || ext === ".js") {
      res.type("text/javascript");
    } else if (ext === ".wasm") {
      res.type("application/wasm");
    }
  },
};

const clientFile = path.join(__dirname, "client", "interstellar.html");
const frameFile = path.join(__dirname, "static", "frame.html");

// The standalone HTML frontend. Served at / so the server works on its own,
// and at /client.html so people can download the file and run it anywhere.
app.get("/", (_req, res) => res.sendFile(clientFile));
app.get("/client.html", (req, res) => {
  if ("download" in req.query) {
    res.setHeader("Content-Disposition", 'attachment; filename="interstellar.html"');
  }
  res.sendFile(clientFile);
});

// The frame shell: a page on this origin that owns the service worker and
// the proxy transport. The HTML frontend embeds one per tab and drives it
// with postMessage.
app.get("/frame", (req, res) => {
  const user = requestUser(req);
  if (!user) {
    return res.status(401).type("html").send('<!doctype html><title>Unauthorized</title><body style="font-family:sans-serif;background:#222;color:#fff;display:grid;place-items:center;height:100vh;margin:0"><p>This server is password protected. Sign in from the Interstellar client first.</p>');
  }
  if (challengeEnabled && req.query.token) {
    res.cookie(TOKEN_COOKIE, makeToken(user), cookieOptions(req));
  }
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(frameFile);
});

app.use(express.static(path.join(__dirname, "static")));
app.use("/ca", cors({ origin: true }));
app.use("/bm", express.static(baremuxPath, transportStaticOptions));
app.use("/ep", express.static(epoxyDistPath, transportStaticOptions));

const routes = [
  { path: "/b", file: "apps.html" },
  { path: "/a", file: "games.html" },
  { path: "/play.html", file: "games.html" },
  { path: "/c", file: "settings.html" },
  { path: "/d", file: "tabs.html" },
  { path: "/legacy", file: "index.html" },
];

// biome-ignore lint: idk
routes.forEach(route => {
  app.get(route.path, (_req, res) => {
    res.sendFile(path.join(__dirname, "static", route.file));
  });
});

app.use((req, res, next) => {
  res.status(404).sendFile(path.join(__dirname, "static", "404.html"));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).sendFile(path.join(__dirname, "static", "404.html"));
});

/* ------------------------------------------------------------------ */
/*  Control WebSocket (/ws) used by the standalone HTML frontend        */
/* ------------------------------------------------------------------ */

const SEARCH_ENGINES = {
  Brave: "https://search.brave.com/search?q=",
  Google: "https://www.google.com/search?q=",
  Bing: "https://www.bing.com/search?q=",
  Qwant: "https://www.qwant.com/?q=",
  Startpage: "https://www.startpage.com/search?q=",
  SearchEncrypt: "https://www.searchencrypt.com/search/?q=",
  Ecosia: "https://www.ecosia.org/search?q=",
};

const listCache = new Map();
function loadList(kind) {
  const files = { apps: "a.min.json", games: "g.min.json" };
  const file = files[kind];
  if (!file) throw new Error(`Unknown list "${kind}"`);
  const full = path.join(__dirname, "static", "assets", "json", file);
  const stat = fs.statSync(full);
  const cached = listCache.get(kind);
  if (cached && cached.mtime === stat.mtimeMs) return cached.data;
  const data = JSON.parse(fs.readFileSync(full, "utf8"));
  listCache.set(kind, { mtime: stat.mtimeMs, data });
  return data;
}

function looksLikeUrl(value = "") {
  return /^http(s?):\/\//.test(value) || (value.includes(".") && value[0] !== " ");
}

function resolveInput(input, engine) {
  let url = String(input || "").trim();
  if (!url) throw new Error("Nothing to open");
  if (url.startsWith("/")) return url; // local asset such as /e/...
  const searchUrl = SEARCH_ENGINES[engine] || (typeof engine === "string" && engine.startsWith("http") ? engine : SEARCH_ENGINES.Brave);
  if (!looksLikeUrl(url)) {
    url = searchUrl + encodeURIComponent(url);
  } else if (!(url.startsWith("https://") || url.startsWith("http://"))) {
    url = `https://${url}`;
  }
  return url;
}

function helloPayload() {
  return {
    name: "Interstellar",
    version: pkg.version,
    challenge: challengeEnabled,
    engines: ["sj", "uv", "dy"],
    defaultEngine: "sj",
    searchEngines: SEARCH_ENGINES,
    frame: "/frame",
    wisp: "/wisp/",
    time: Date.now(),
  };
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function reply(ws, id, result) {
  ws.send(JSON.stringify({ id, ok: true, ...result }));
}

function fail(ws, id, message, code = "error") {
  ws.send(JSON.stringify({ id, ok: false, error: message, code }));
}

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.user = requestUser(req);
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.send(JSON.stringify({ type: "hello", ...helloPayload(), authed: Boolean(ws.user) }));

  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return fail(ws, null, "Invalid JSON", "bad-request");
    }
    const { id, type } = msg;
    try {
      switch (type) {
        case "hello":
          return reply(ws, id, { ...helloPayload(), authed: Boolean(ws.user) });
        case "ping":
          return reply(ws, id, { pong: true, time: Date.now() });
        case "auth": {
          if (!challengeEnabled) {
            ws.user = "anonymous";
            return reply(ws, id, { token: null, user: "anonymous" });
          }
          if (msg.token) {
            const user = verifyToken(msg.token);
            if (!user) return fail(ws, id, "Session expired, sign in again", "unauthorized");
            ws.user = user;
            return reply(ws, id, { token: makeToken(user), user });
          }
          if (!checkCredentials(msg.username, msg.password)) {
            return fail(ws, id, "Wrong username or password", "unauthorized");
          }
          ws.user = msg.username;
          return reply(ws, id, { token: makeToken(msg.username), user: msg.username });
        }
        case "list":
          if (!ws.user) return fail(ws, id, "Sign in first", "unauthorized");
          return reply(ws, id, { kind: msg.kind, items: loadList(msg.kind) });
        case "resolve":
          if (!ws.user) return fail(ws, id, "Sign in first", "unauthorized");
          return reply(ws, id, { url: resolveInput(msg.input, msg.engine) });
        default:
          return fail(ws, id, `Unknown message type "${type}"`, "bad-request");
      }
    } catch (error) {
      return fail(ws, id, error.message);
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

function rejectUpgrade(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/* ------------------------------------------------------------------ */
/*  HTTP + upgrade routing                                             */
/* ------------------------------------------------------------------ */

server.on("request", (req, res) => {
  if (bareServer.shouldRoute(req)) {
    bareServer.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

server.on("upgrade", (req, socket, head) => {
  if (bareServer.shouldRoute(req)) {
    return bareServer.routeUpgrade(req, socket, head);
  }
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/ws") {
    if (!originAllowed(req.headers.origin)) return rejectUpgrade(socket, 403, "Forbidden");
    return wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  }
  // Everything else is the wisp transport used by the proxy engines.
  if (challengeEnabled && !requestUser(req)) return rejectUpgrade(socket, 401, "Unauthorized");
  // wisp-js reads the request path and would try to resolve "?token=..." as a
  // host name, so hand it the bare path once the token has been checked.
  req.url = pathname;
  wisp.routeRequest(req, socket, head);
});

server.on("listening", () => {
  console.log(chalk.green(`🌍 Server is running on http://localhost:${PORT}`));
  console.log(chalk.cyan(`🔌 Control WebSocket: ws://localhost:${PORT}/ws`));
  console.log(chalk.cyan(`📄 Standalone client: http://localhost:${PORT}/client.html?download`));
  if (!allowedOrigins.includes("*")) {
    console.log(chalk.magenta(`🛡  Allowed origins: ${allowedOrigins.join(", ")}`));
  }
});

server.listen({ port: PORT });
