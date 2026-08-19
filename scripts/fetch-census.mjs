/**
 * Download US Census cartographic boundary shapefiles → data-src/*.geojson
 *
 * The 500k ("1:500,000") series is the highest-resolution generalized boundary
 * set Census publishes for web cartography. Source page:
 *   https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html
 *
 * Requires GDAL (`ogr2ogr` on PATH):  sudo apt install gdal-bin
 *
 * GDAL reads the shapefile straight out of the remote zip via /vsizip//vsicurl/,
 * so there is no download, unzip or cache step here — verified byte-identical to
 * converting a locally downloaded copy.
 *
 * Coordinates are left in the source datum, NAD83 / EPSG:4269. NAD83 and WGS84
 * differ by ~1-2 m in CONUS, an order of magnitude below the ~150 m
 * generalization already baked into the 500k series, and reprojecting makes
 * GDAL stitch together several region-specific coordinate operations. Not worth
 * the inconsistency for no measurable gain.
 */

import { execFileSync } from "child_process";
import { rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data-src");
const cartoUrl = (year) => `https://www2.census.gov/geo/tiger/GENZ${year}/shp`;

/** `fields` is passed to ogr2ogr -select: everything else is dropped so the
 *  intermediate GeoJSON stays lean. Keep in sync with PROPERTIES in preprocess.mjs.
 *
 *  `year` is the release, which is not the boundary vintage: GENZ2018 ships
 *  ZCTA510, the 2010 ZCTAs. ZCTAs are decennial, so the 2020 set (ZCTA520) is
 *  the current one and Census stopped shipping ZCTAs in the cartographic
 *  boundary series after GENZ2020 — there is nothing newer to move to until
 *  the 2030 census. States and counties are true annual vintages, so they
 *  track the latest release. */
const LAYERS = {
  "us-states.geojson":   { year: 2025, zip: "cb_2025_us_state_500k",   fields: "STATEFP,STUSPS,NAME" },
  "us-counties.geojson": { year: 2025, zip: "cb_2025_us_county_500k",  fields: "STATEFP,COUNTYFP,NAME" },
  "us-zctas.geojson":    { year: 2020, zip: "cb_2020_us_zcta520_500k", fields: "ZCTA5CE20" },
};

for (const [out, { year, zip, fields }] of Object.entries(LAYERS)) {
  const outPath = join(SRC_DIR, out);
  rmSync(outPath, { force: true }); // ogr2ogr refuses to overwrite
  console.log(`${out} ← ${zip}.zip`);
  execFileSync("ogr2ogr", [
    "-f", "GeoJSON",
    "-select", fields,
    // 6 decimals ≈ 11 cm, far below the 500k series' generalization tolerance.
    "-lco", "COORDINATE_PRECISION=6",
    outPath,
    `/vsizip//vsicurl/${cartoUrl(year)}/${zip}.zip/${zip}.shp`,
  ], { stdio: ["ignore", "inherit", "inherit"] });
}
console.log("\nDone. Now run: node scripts/preprocess.mjs");
