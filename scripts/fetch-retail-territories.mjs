/**
 * Build the Utility Retail Territories layer → data-src/retail-territories.geojson
 *
 * Source: HIFLD "Electric Retail Service Territories" republished as GeoParquet
 * by SeerAI on Source Cooperative. 2931 service territories, Public Domain.
 *   https://source.coop/seerai/hifld/electric-retail-service-territories/retail-service-territories
 *
 * Same GeoParquet + zstd path as fetch-control-areas.mjs; see that file for why
 * hyparquet needs no WKB parser and why node:zlib covers the compression.
 *
 * Two things differ from the control-areas script:
 *
 * - HIFLD encodes unknowns as sentinels rather than nulls: "NOT AVAILABLE" in
 *   text columns (1685 rows in `type` alone) and -999999 in numeric ones (27
 *   rows in `customers`). Left alone these ship as literal CSV values, so both
 *   are normalised to empty here. preprocess.mjs already drops empty strings.
 * - Column names are lower-cased on the way out. The manifest, preprocess.mjs
 *   and the published .gjbf all key off `name`/`hold_co`/`ctrl_area`, and
 *   renaming those would break every saved column selection.
 *
 * Territories overlap (a holding company's footprint can cover its subsidiaries'),
 * so -clean is omitted for the same reason as in fetch-control-areas.mjs.
 *
 * Unlike that script, features are NOT area-sorted, so first-match is arbitrary
 * where territories overlap: downtown Seattle falls inside both CITY OF SEATTLE
 * and CITY OF MILTON, whose upstream HIFLD polygon spans most of Puget Sound.
 * The multiple-match default is "join", which returns both. Add the same
 * smallest-area-first sort as fetch-control-areas.mjs if first-match needs to
 * pick the most specific territory here too.
 *
 *   node scripts/fetch-retail-territories.mjs                  # fetch from Source Cooperative
 *   node scripts/fetch-retail-territories.mjs --file x.parquet # use a local parquet
 */

import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, statSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parquetReadObjects } from "hyparquet";
import { compressors, download, localParquet, mb, resolvePartUrl } from "./source-coop.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "data-src");
const CACHE = join(SRC_DIR, ".cache");
const MAPSHAPER = join(ROOT, "node_modules", "mapshaper", "bin", "mapshaper");

/** Key prefix in the Source Cooperative bucket. This is a directory of Spark
 *  part files, not a single object — see source-coop.mjs. */
const PREFIX =
  "electric-retail-service-territories/retail-service-territories/retail-service-territories.parquet";

/** Douglas-Peucker tolerance in metres — matches every other layer here, so the
 *  worst-case border error is the same across the whole dataset. */
const INTERVAL = 200;

/** HIFLD column → the lower-case key the manifest and preprocess.mjs expect.
 *  The capacity/energy columns (RETAIL_MWH, SUMMR_PEAK, …) are deliberately
 *  dropped: they are not exposed as output columns and are sentinel-heavy. */
const COLUMNS = {
  NAME: "name",
  TYPE: "type",
  STATE: "state",
  HOLDING_CO: "hold_co",
  CNTRL_AREA: "ctrl_area",
  CUSTOMERS: "customers",
};


/** HIFLD's placeholders for "we don't know", in the casings it actually uses. */
const UNKNOWN = new Set(["", "NOT AVAILABLE", "NOT-AVAILABLE", "N/A", "NULL", "UNKNOWN"]);

/**
 * Normalise one HIFLD value to a plain string, mapping sentinels to "".
 *
 * Negative numbers are unknowns for every column carried here — a territory
 * cannot serve -999999 customers — so the whole negative range is treated as a
 * sentinel rather than matching -999999 exactly, which is only the most common
 * of several (-999, -99999) HIFLD uses across its layers.
 */
function clean(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? String(n) : "";
  }
  const s = String(v).trim();
  return UNKNOWN.has(s.toUpperCase()) ? "" : s;
}




async function main() {
  const fileArg = process.argv.indexOf("--file");
  const parquetPath =
    fileArg !== -1
      ? process.argv[fileArg + 1]
      : await download(await resolvePartUrl(PREFIX), join(CACHE, "retail-service-territories.parquet"));

  console.log(`\nReading ${parquetPath}`);
  const { file, close } = await localParquet(parquetPath);
  const rows = await parquetReadObjects({
    file,
    columns: [...Object.keys(COLUMNS), "geometry"],
    compressors,
  });
  await close();

  const features = [];
  const cleaned = {};
  for (const r of rows) {
    const g = r.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
    const properties = {};
    for (const [src, key] of Object.entries(COLUMNS)) {
      const raw = r[src];
      properties[key] = clean(raw);
      const hadValue = raw !== null && raw !== undefined && String(raw).trim() !== "";
      if (properties[key] === "" && hadValue) cleaned[key] = (cleaned[key] ?? 0) + 1;
    }
    features.push({ type: "Feature", properties, geometry: g });
  }
  console.log(`  ${features.length} features`);
  for (const [k, n] of Object.entries(cleaned)) console.log(`  sentinel → empty: ${k} ${n}`);

  mkdirSync(SRC_DIR, { recursive: true });
  mkdirSync(CACHE, { recursive: true });
  const raw = join(CACHE, "retail-territories.raw.geojson");
  writeFileSync(raw, JSON.stringify({ type: "FeatureCollection", features }));
  console.log(`  raw     ${mb(statSync(raw).size)}`);

  const out = join(SRC_DIR, "retail-territories.geojson");
  process.stdout.write(`  simplify dp ${INTERVAL} m … `);
  execFileSync("node", [
    MAPSHAPER, raw,
    // keep-shapes stops small municipal territories collapsing away entirely.
    "-simplify", "dp", `interval=${INTERVAL}`, "keep-shapes",
    // precision matches COORD_SCALE in preprocess.mjs.
    "-o", "precision=0.000001", out,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(mb(statSync(out).size));
  rmSync(raw, { force: true });

  console.log(`\nWrote ${out}\nNext: node scripts/preprocess.mjs`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
