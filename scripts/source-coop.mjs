/**
 * Locating a dataset in SeerAI's HIFLD archive on Source Cooperative.
 *
 * HIFLD itself was retired in August 2025; this archive is the live location
 * for its layers, and the GeoPlatform hub pages it used to serve are gone.
 *
 * On 2025-11-17 SeerAI republished the archive as Spark output, which made every
 * `…/<name>.parquet` a DIRECTORY of part files rather than a file. Hardcoded
 * object URLs written before that date now 404. The part name embeds a Spark
 * transaction id that changes on every republish, so it has to be discovered by
 * listing the prefix — which is what this module is for.
 *
 *   https://source.coop/seerai/hifld
 */

import { existsSync, mkdirSync, writeFileSync, statSync } from "fs";
import { open } from "fs/promises";
import { zstdDecompressSync } from "zlib";
import { dirname } from "path";

const BUCKET = "https://data.source.coop/seerai";
const REPO = "hifld";

export const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/**
 * Resolve the single `.parquet` part file under a dataset prefix.
 *
 * The `/seerai/hifld` path selects the bucket and already contributes the
 * `hifld/` key prefix, so `prefix` is relative to that and must NOT repeat it.
 * Slashes are left unescaped — the listing endpoint treats a percent-encoded
 * prefix as a literal key and returns nothing.
 *
 * @param prefix Key prefix below the repo root, e.g.
 *   "control-areas/control-areas/control-areas.parquet"
 * @returns Fully-qualified https URL to the part file.
 */
export async function resolvePartUrl(prefix) {
  const res = await fetch(`${BUCKET}/${REPO}?list-type=2&prefix=${prefix}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} listing ${prefix}`);
  const xml = await res.text();
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  const part = keys.find((k) => k.endsWith(".parquet"));
  if (!part) {
    throw new Error(
      `no .parquet part under ${prefix}\n` +
        `The archive layout may have changed again; listed keys:\n  ${keys.join("\n  ") || "(none)"}`,
    );
  }
  return `${BUCKET}/${part}`;
}

/** Download `url` to `dest` unless it is already cached there. */
export async function download(url, dest) {
  if (existsSync(dest)) {
    console.log(`  cached  ${dest.split("/").pop()}  (${mb(statSync(dest).size)})`);
    return dest;
  }
  process.stdout.write(`  fetch   ${url} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log(mb(buf.length));
  return dest;
}

/** node:zlib handles zstd; snappy-compressed copies of the same dataset decode
 *  through hyparquet's built-in path, so only ZSTD needs supplying here. */
export const compressors = {
  ZSTD: (input) => {
    const out = zstdDecompressSync(Buffer.from(input));
    return new Uint8Array(out.buffer, out.byteOffset, out.length);
  },
};

/** Random-access view over a local parquet, as hyparquet's AsyncBuffer. */
export async function localParquet(path) {
  const fh = await open(path, "r");
  const { size } = await fh.stat();
  return {
    close: () => fh.close(),
    file: {
      byteLength: size,
      async slice(start, end) {
        const len = (end ?? size) - start;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + len);
      },
    },
  };
}
