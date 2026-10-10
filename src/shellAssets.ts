import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { RequestHandler } from "express";

type Asset = { body: Buffer; version: string; gzip?: Buffer; stamp: string };

/** Content versions prevent a cached shell script surviving an update to its bytes. */
export function shellAssets(publicDir: string, vendors: Record<string, string | (() => string)>): RequestHandler {
  const cache = new Map<string, Asset>();
  function read(url: string): Asset | null {
    const source = Object.hasOwn(vendors, url) ? vendors[url] : (/^\/[\w.-]+\.(?:js|css|svg)$/.test(url) ? path.join(publicDir, url.slice(1)) : null);
    if (!source) return null;
    let body: Buffer;
    let stamp: string;
    if (typeof source === "function") {
      const previous = cache.get(url);
      if (previous) return previous;
      body = Buffer.from(source());
      stamp = "generated";
    } else {
      let stat: fs.Stats;
      try { stat = fs.statSync(source); } catch { return null; }
      if (!stat.isFile()) return null;
      stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      const previous = cache.get(url);
      if (previous?.stamp === stamp) return previous;
      body = fs.readFileSync(source);
    }
    const asset = { body, stamp, version: createHash("sha256").update(body).digest("hex").slice(0, 16) };
    cache.set(url, asset);
    return asset;
  }
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let asset: Asset | null;
    if (req.path === "/" || req.path === "/index.html") {
      const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8").replace(
        /((?:src|href)=["'])(\.\/|\/)([\w./-]+\.(?:js|css|svg))(?:\?v=[\w.-]+)?(["'])/g,
        (whole, prefix, base, name, quote) => {
          const item = read(`/${name}`);
          return item ? `${prefix}${base}${name}?v=${item.version}${quote}` : whole;
        },
      );
      const body = Buffer.from(html);
      asset = { body, stamp: "html", version: createHash("sha256").update(body).digest("hex").slice(0, 16) };
      res.type("html").set("Cache-Control", "no-store");
    } else {
      asset = read(req.path);
      if (!asset) return next();
      res.type(path.extname(req.path));
      res.set("Cache-Control", req.query.v === asset.version ? "public, max-age=31536000, immutable" : "no-cache");
    }
    res.set("ETag", `"${asset.version}"`);
    res.vary("Accept-Encoding");
    if (req.fresh) { res.status(304).end(); return; }
    if (asset.body.length >= 1024 && req.acceptsEncodings("gzip")) {
      asset.gzip ??= gzipSync(asset.body);
      res.set("Content-Encoding", "gzip").send(asset.gzip);
    } else res.send(asset.body);
  };
}
