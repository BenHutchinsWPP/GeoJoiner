/**
 * Build the Control Areas layer → data-src/control-areas.geojson
 *
 * Source: HIFLD "Control Areas" republished as GeoParquet by SeerAI on
 * Source Cooperative. 71 electric control areas (the operational balancing
 * footprints utilities dispatch against), Public Domain.
 *   https://source.coop/seerai/hifld/control-areas
 *
 * The file is GeoParquet 1.1 — WKB geometry plus a `geo` schema-metadata block.
 * hyparquet reads that metadata and hands back GeoJSON geometry directly, so no
 * WKB parser is needed here. Zstd page compression is decoded by node:zlib,
 * built in since Node 22.15, rather than a second dependency.
 *
 * At full resolution this is 2.28 M vertices across 71 features — denser per
 * feature than any other layer here, and almost all of it is coastline detail
 * on territories whose land borders are what a point-in-polygon join actually
 * cares about. Simplified with the same Douglas-Peucker tolerance used for
 * geoBoundaries, so the worst-case border error stays bounded at INTERVAL.
 *
 * Requires no external binaries — mapshaper is already a devDependency.
 *
 *   node scripts/fetch-control-areas.mjs                 # fetch from Source Cooperative
 *   node scripts/fetch-control-areas.mjs --file x.parquet # use a local parquet
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
const PREFIX = "control-areas/control-areas/control-areas.parquet";

/** Douglas-Peucker tolerance in metres — the layer's worst-case border error.
 *  Matches fetch-boundaries.mjs so both layers carry the same guarantee. */
const INTERVAL = 200;

/** Properties carried through to the .geojson. The capacity and load columns
 *  (TOTAL_CAP, PEAK_LOAD, …) are deliberately dropped: HIFLD encodes unknowns
 *  as negative sentinels, which would ship as "-999999" in a joined CSV. */
const COLUMNS = ["NAME", "ID", "STATE", "geometry"];


/**
 * Outer-ring area in square degrees, scaled by cos(lat) so longitude shrinks
 * toward the poles. Only used to rank features against each other, so the
 * shoelace sum on a plate carrée plane is precise enough — no projection.
 */
function approxArea(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let total = 0;
  for (const rings of polys) {
    const outer = rings[0];
    if (!outer || outer.length < 4) continue;
    let sum = 0, latSum = 0;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      sum += outer[j][0] * outer[i][1] - outer[i][0] * outer[j][1];
      latSum += outer[i][1];
    }
    total += Math.abs(sum / 2) * Math.cos((latSum / outer.length) * Math.PI / 180);
  }
  return total;
}




async function main() {
  const fileArg = process.argv.indexOf("--file");
  const parquetPath =
    fileArg !== -1
      ? process.argv[fileArg + 1]
      : await download(await resolvePartUrl(PREFIX), join(CACHE, "control-areas.parquet"));

  console.log(`\nReading ${parquetPath}`);
  const { file, close } = await localParquet(parquetPath);
  const rows = await parquetReadObjects({ file, columns: COLUMNS, compressors });
  await close();

  const features = [];
  for (const r of rows) {
    const g = r.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
    features.push({
      type: "Feature",
      properties: {
        NAME: String(r.NAME ?? "").trim(),
        ID: String(r.ID ?? "").trim(),
        STATE: String(r.STATE ?? "").trim(),
      },
      geometry: g,
    });
  }
  console.log(`  ${features.length} features`);

  // Control areas overlap, unlike the tessellating admin layers, so feature
  // order decides what a first-match join returns. The federal overlays (WAPA,
  // BPA) blanket dozens of local utilities; left in source order they win, and
  // Sacramento reads "WESTERN AREA POWER ADMINISTRATION" instead of "BALANCING
  // AUTHORITY OF NORTHERN CALIFORNIA". Smallest-first makes first-match return
  // the most specific control area covering the point. The broad overlays are
  // still there for the "join"/"all" multiple-match modes.
  features.sort((a, b) => approxArea(a.geometry) - approxArea(b.geometry));

  mkdirSync(SRC_DIR, { recursive: true });
  const raw = join(CACHE, "control-areas.raw.geojson");
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(raw, JSON.stringify({ type: "FeatureCollection", features }));
  console.log(`  raw     ${mb(statSync(raw).size)}`);

  const out = join(SRC_DIR, "control-areas.geojson");
  process.stdout.write(`  simplify dp ${INTERVAL} m … `);
  execFileSync("node", [
    MAPSHAPER, raw,
    // keep-shapes stops the small island footprints (Hawaii, coastal slivers)
    // from collapsing away entirely at this tolerance.
    "-simplify", "dp", `interval=${INTERVAL}`, "keep-shapes",
    // No -clean here, unlike fetch-boundaries.mjs. Admin boundaries tessellate,
    // so mapshaper can treat every overlap as a sliver to dissolve. Control
    // areas genuinely overlap one another, and -clean read those overlaps as
    // slivers and dropped 20 of the 71 features outright.
    // precision matches COORD_SCALE in preprocess.mjs — storing more decimals
    // than the .gjbf keeps is wasted bytes.
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
