import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { dataDir } from "../config.js";
import { detectSearchPack, searchPackDir } from "./pack.js";

export const MAX_PACK_ZIP_BYTES = 2 * 1024 ** 3;
const MAX_UNPACKED_BYTES = 4 * 1024 ** 3;
const installing = new Set<string>();

function byteLimit(max: number): Transform {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > max ? new Error("Search pack exceeds the size limit") : null, chunk);
  } });
}

async function extract(zipPath: string, folder: string): Promise<void> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => err ? reject(err) : resolve(zip!));
  });
  let total = 0, count = 0;
  const names = new Set<string>();
  try {
    for (;;) {
      const entry = await new Promise<Entry | null>((resolve, reject) => {
        const clean = () => { zip.off("entry", onEntry); zip.off("end", onEnd); zip.off("error", onError); };
        const onEntry = (entry: Entry) => { clean(); resolve(entry); };
        const onEnd = () => { clean(); resolve(null); };
        const onError = (err: Error) => { clean(); reject(err); };
        zip.once("entry", onEntry); zip.once("end", onEnd); zip.once("error", onError);
        zip.readEntry();
      });
      if (!entry) break;
      const name = entry.fileName;
      const parts = name.replace(/\/$/, "").split("/");
      // Reject links, Windows devices/streams and ambiguous paths on every platform.
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (++count > 50_000 || parts.some(p => !p || p === "." || p === ".." || /[\\<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) || (mode && mode !== 0x8000 && mode !== 0x4000)) {
        throw new Error("Unsafe file entry in search pack ZIP");
      }
      const key = parts.join("/").toLowerCase();
      if (names.has(key)) throw new Error("Duplicate file entry in search pack ZIP");
      names.add(key);
      total += entry.uncompressedSize;
      if (!Number.isSafeInteger(total) || total > MAX_UNPACKED_BYTES) throw new Error("Search pack exceeds the size limit");
      const target = path.join(folder, ...parts);
      if (name.endsWith("/")) { await fsp.mkdir(target, { recursive: true }); continue; }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const stream = await new Promise<Readable>((resolve, reject) => {
        zip.openReadStream(entry, (err, stream) => err ? reject(err) : resolve(stream!));
      });
      const onError = (err: Error) => stream.destroy(err);
      zip.on("error", onError);
      try { await pipeline(stream, byteLimit(entry.uncompressedSize), fs.createWriteStream(target, { flags: "wx" })); }
      finally { zip.off("error", onError); }
    }
  } finally { zip.close(); }
}

/** Stage and verify before touching the current pack; restore it if the swap fails. */
export async function installSearchPack(input: Readable, root = dataDir(), beforeReplace: () => Promise<void> = async () => {}): Promise<void> {
  root = path.resolve(root);
  if (installing.has(root)) throw new Error("A search pack installation is already in progress");
  installing.add(root);
  let temp: string | undefined;
  let retainBackup = false;
  try {
    const packs = path.dirname(searchPackDir(root));
    await fsp.mkdir(packs, { recursive: true });
    temp = await fsp.mkdtemp(path.join(packs, ".search-install-"));
    const archive = path.join(temp, "pack.zip");
    await pipeline(input, byteLimit(MAX_PACK_ZIP_BYTES), fs.createWriteStream(archive));
    const stageRoot = path.join(temp, "stage");
    const stage = searchPackDir(stageRoot);
    await fsp.mkdir(stage, { recursive: true });
    await extract(archive, stage);
    const status = detectSearchPack(stageRoot);
    if (status.status !== "ready" || !status.pack) throw new Error(status.status === "not-installed" ? "The ZIP must contain pack.json at its root" : status.message);
    for (const [name, expected] of Object.entries(status.pack.files)) {
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(path.join(stage, name))) hash.update(chunk);
      if (hash.digest("hex") !== expected) throw new Error(`Search pack checksum failed: ${name}`);
    }
    await beforeReplace();
    const destination = searchPackDir(root), backup = path.join(temp, "previous");
    let moved = false;
    try { await fsp.rename(destination, backup); moved = true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    try { await fsp.rename(stage, destination); }
    catch (err) {
      if (moved) {
        try { await fsp.rename(backup, destination); }
        catch {
          retainBackup = true;
          throw new Error(`Cannot restore the previous search pack. Its files are preserved at ${backup}`);
        }
      }
      throw err;
    }
  } finally {
    try { if (temp && !retainBackup) await fsp.rm(temp, { recursive: true, force: true }); }
    finally { installing.delete(root); }
  }
}
