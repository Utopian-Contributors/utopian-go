import compression from "compression";
import express from "express";
import path from "path";
import { BRAVE_API_KEY, PORT } from "./config";
import { apiRouter } from "./routes/api";

const app = express();
const publicDir = path.join(__dirname, "..", "public");

// gzip/brotli-negotiated compression — bandwidth budget is measured gzip.
app.use(compression());

// Built SPA assets (HTML/CSS/JS).
// HTML must not be cached long — it carries ?v= content hashes for CSS/JS.
// CSS/JS can be cached; new deploys change the query string in index.html.
app.use(
  express.static(publicDir, {
    index: false, // never serve cached index via static; use the handler below
    maxAge: process.env.NODE_ENV === "production" ? "7d" : 0,
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith(`${path.sep}index.html`) || filePath.endsWith("/index.html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

app.use(apiRouter);

function sendIndex(res: express.Response, next: express.NextFunction) {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(publicDir, "index.html"), (err) => {
    if (err) next(err);
  });
}

app.get("/", (_req, res, next) => sendIndex(res, next));

// SPA deep-links: unknown non-API GETs fall back to the shell.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  sendIndex(res, next);
});

app.listen(PORT, () => {
  console.log(`utopian-go demo running at http://localhost:${PORT}`);
  if (!BRAVE_API_KEY) {
    console.log("Set BRAVE_API_KEY env var to get live results.");
  }
});
