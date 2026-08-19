/**
 * Build the global Countries + Admin-1 layers → data-src/{countries,admin1}.geojson
 *
 * Source: geoBoundaries CGAZ (Comprehensive Global Administrative Zones), a
 * composite of per-country authoritative sources — US Census for the USA,
 * StatCan for Canada, INEGI for Mexico — with ADM0 clipped to the US State
 * Department LSIB. CC BY 4.0, so attribution is required; see docs/DATA_SOURCES.md.
 *   https://www.geoboundaries.org/
 *
 * Replaces Natural Earth 110m/50m, which was never built for point-in-polygon.
 * Measured against full-resolution CGAZ along the US national outline (~112k
 * sample vertices, distance from each true vertex to the layer's boundary):
 *
 *   Natural Earth 110m     median 7552 m   p90 50191 m   p99.9 181539 m
 *   Natural Earth 10m      median  571 m   p90  1575 m   p99.9  11678 m
 *   CGAZ, dp 200 m         median   41 m   p90   132 m   p99.9    198 m
 *
 * `-simplify dp` is load-bearing. mapshaper's default is Visvalingam, whose
 * `interval=` is an area threshold with no deviation bound — at the same file
 * size it left a p99.9 of 14.5 km. Douglas-Peucker guarantees no original point
 * sits further than `interval` from the retained line, and mapshaper applies it
 * to shared arcs, so neighbouring polygons stay welded (no sliver gaps).
 *
 * Requires no external binaries — mapshaper is already a devDependency.
 * Downloads (~815 MB) are cached in data-src/.cache and reused.
 */

import { execFileSync } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "data-src");
const CACHE = join(SRC_DIR, ".cache");
const MAPSHAPER = join(ROOT, "node_modules", "mapshaper", "bin", "mapshaper");

/** Douglas-Peucker tolerance in metres — the layer's worst-case border error. */
const INTERVAL = 200;

const CGAZ = "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/CGAZ";
const NE = "https://github.com/nvkelso/natural-earth-vector/raw/master/geojson";

const SOURCES = {
  "cgaz-adm0.geojson": `${CGAZ}/geoBoundariesCGAZ_ADM0.geojson`,
  "cgaz-adm1.geojson": `${CGAZ}/geoBoundariesCGAZ_ADM1.geojson`,
  "ne10-countries.geojson": `${NE}/ne_10m_admin_0_countries.geojson`,
};

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function download(name, url) {
  const dest = join(CACHE, name);
  if (existsSync(dest)) {
    console.log(`  cached  ${name}  (${mb(statSync(dest).size)})`);
    return dest;
  }
  process.stdout.write(`  fetch   ${name} … `);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log(mb(statSync(dest).size));
  return dest;
}

/**
 * Simplify with topology-aware Douglas-Peucker. `keep-shapes` stops whole
 * features being dropped; `-clean` repairs the overlaps DP can open between
 * adjacent units. Both are needed for point-in-polygon: a gap between two
 * states means a point matches nothing, an overlap means it matches twice.
 */
function simplify(src, out) {
  process.stdout.write(`  simplify ${out.split("/").pop()} … `);
  execFileSync("node", [
    MAPSHAPER, src,
    "-filter-fields", "shapeName,shapeGroup",
    "-simplify", "dp", `interval=${INTERVAL}`, "keep-shapes",
    "-clean",
    "-o", "precision=0.000001", out,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(mb(statSync(out).size));
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/**
 * Natural Earth leaves ISO_A3 as "-99" for entities it declines to code, and
 * falls back to its own ADM0_A3. Only a real ISO_A3 marks a territory worth
 * appending below: the ADM0_A3-only rows are NE's own pseudo-entities (Bir
 * Tawil, Scarborough Reef, Cyprus No Mans Area, NE's coarse Kosovo), and CGAZ
 * already carries those areas at 200 m under its own codes. Appending them
 * would shadow the better geometry, since territories are matched first.
 */
const isoA3 = (p) => (p.ISO_A3 && p.ISO_A3 !== "-99" ? p.ISO_A3 : null);
const anyIso = (p) => isoA3(p) ?? p.ADM0_A3;

/** CGAZ already names these, at higher fidelity, under a different code. */
const SKIP_TERRITORY = new Set([
  "PSE", // CGAZ splits it into "Gaza Strip" and "West Bank"
]);

mkdirSync(CACHE, { recursive: true });

console.log("Downloading sources (cached in data-src/.cache)…");
const paths = {};
for (const [name, url] of Object.entries(SOURCES)) paths[name] = await download(name, url);

console.log(`\nSimplifying to Douglas-Peucker ${INTERVAL} m…`);
const adm0 = join(CACHE, `adm0-dp${INTERVAL}.geojson`);
const adm1 = join(CACHE, `adm1-dp${INTERVAL}.geojson`);
if (!existsSync(adm0)) simplify(paths["cgaz-adm0.geojson"], adm0);
if (!existsSync(adm1)) simplify(paths["cgaz-adm1.geojson"], adm1);

// ── Countries ────────────────────────────────────────────────────────────
//
// CGAZ ADM0 is sovereign-state level: it folds dependencies into the parent, so
// Hong Kong reads "China" and Bermuda reads "United Kingdom". Natural Earth
// names them separately, and dropping ~40 labels the old layer had would be a
// regression, so NE's territory polygons are appended for the ISO codes CGAZ
// has no entity for. They cost ~0.1 MB — they are all small islands.
//
// Territories are written FIRST because they sit geometrically inside their
// parent's CGAZ polygon. The worker breaks on the first hit in feature order
// (geoProcessor.worker.ts), so a Guam point must meet Guam before it meets the
// United States. Keep this ordering if you touch the file.
console.log("\nBuilding countries.geojson…");
const ne0 = readJson(paths["ne10-countries.geojson"]).features;
// Indexed on either code so the attribute join is as complete as possible;
// the territory filter below is stricter and uses ISO_A3 only.
const neByIso = new Map(ne0.map((f) => [anyIso(f.properties), f]));

const cgaz0 = readJson(adm0).features;
const haveIso = new Set(cgaz0.map((f) => f.properties.shapeGroup));

let joined = 0;
const sovereign = cgaz0.map((f) => {
  const iso = f.properties.shapeGroup;
  const ne = neByIso.get(iso)?.properties;
  if (ne) joined++;
  return {
    type: "Feature",
    properties: {
      ADMIN: f.properties.shapeName,
      ISO_A3: iso,
      // ISO_A2 / CONTINENT exist only in Natural Earth. Blank for the ~20 CGAZ
      // disputed zones (Aksai Chin, Abyei, Spratly Is …) NE has no row for; the
      // manifest exposes them as optional columns, so blank is fine.
      ISO_A2: ne?.ISO_A2 && ne.ISO_A2 !== "-99" ? ne.ISO_A2 : "",
      CONTINENT: ne?.CONTINENT ?? "",
    },
    geometry: f.geometry,
  };
});

const territories = ne0
  .filter((f) => {
    const iso = isoA3(f.properties);
    return iso && !haveIso.has(iso) && !SKIP_TERRITORY.has(iso);
  })
  .map((f) => ({
    type: "Feature",
    properties: {
      ADMIN: f.properties.ADMIN,
      ISO_A3: isoA3(f.properties),
      ISO_A2: f.properties.ISO_A2 !== "-99" ? f.properties.ISO_A2 : "",
      CONTINENT: f.properties.CONTINENT ?? "",
    },
    geometry: f.geometry,
  }));

const countries = { type: "FeatureCollection", features: [...territories, ...sovereign] };
writeFileSync(join(SRC_DIR, "countries.geojson"), JSON.stringify(countries));
console.log(`  ${sovereign.length} CGAZ entities (${joined} joined to NE attributes)`);
console.log(`  ${territories.length} NE territories appended for coverage`);
console.log(`  → countries.geojson  (${mb(statSync(join(SRC_DIR, "countries.geojson")).size)}, ${countries.features.length} features)`);

// ── Admin-1 ──────────────────────────────────────────────────────────────
//
// The layer this replaces was Natural Earth 50m admin-1, which covers only 9
// large countries — everywhere else returned blank. CGAZ ADM1 covers 218.
//
// CGAZ carries no ISO 3166-2 code. It used to be joined in from Natural Earth
// 10m admin-1 by name, but name-matching topped out at 86% — the column was
// blank for the rest (including all five US territories), which silently drops
// rows for anyone filtering on it. A column that is wrong by omission is worse
// than no column, so it is gone. A centroid-in-polygon join against NE geometry
// would be the honest way to bring it back.
console.log("\nBuilding admin1.geojson…");
const countryName = new Map(sovereign.map((f) => [f.properties.ISO_A3, f.properties.ADMIN]));

const admin1 = {
  type: "FeatureCollection",
  features: readJson(adm1).features.map((f) => {
    const iso3 = f.properties.shapeGroup;
    return {
      type: "Feature",
      properties: {
        name: f.properties.shapeName,
        country: countryName.get(iso3) ?? iso3,
        iso_a3: iso3,
      },
      geometry: f.geometry,
    };
  }),
};
writeFileSync(join(SRC_DIR, "admin1.geojson"), JSON.stringify(admin1));
const nCountries = new Set(admin1.features.map((f) => f.properties.iso_a3)).size;
console.log(`  ${admin1.features.length} units across ${nCountries} countries`);
console.log(`  → admin1.geojson  (${mb(statSync(join(SRC_DIR, "admin1.geojson")).size)})`);

console.log("\nDone. Now run: node scripts/preprocess.mjs");
