/**
 * Spot-checks the shipped Utility Retail Territories layer against the real
 * .gjbf asset in public/data, through the real point-in-polygon path.
 *
 * This layer is built straight from HIFLD's GeoParquet, which encodes unknowns
 * as sentinels rather than nulls — "NOT AVAILABLE" in text columns and negative
 * numbers in numeric ones. fetch-retail-territories.mjs maps both to empty. If
 * that normalisation is dropped, 1685 rows ship a literal "NOT AVAILABLE" in
 * the ownership-type CSV column and 24 ship "-999999" customers, which is what
 * the sentinel cases below exist to catch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { decodeGjbf, pointInFeature, type GjbfData } from "../binaryFormat";

const load = (name: string) => {
  const b = readFileSync(join(__dirname, "..", "..", "..", "public", "data", name));
  return decodeGjbf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
};

/** Every territory covering the point, in feature order. */
function lookupAll(data: GjbfData, lon: number, lat: number, key: string) {
  const hits: string[] = [];
  for (let fi = 0; fi < data.numFeatures; fi++) {
    const o = fi * 4;
    if (lon < data.bboxes[o] || lat < data.bboxes[o + 1] ||
        lon > data.bboxes[o + 2] || lat > data.bboxes[o + 3]) continue;
    if (pointInFeature(lon, lat, fi, data)) hits.push(data.propColumns[key][fi]);
  }
  return hits;
}

const retail = load("retail-territories.gjbf");

describe("utility retail territories layer", () => {
  it("ships all 2931 HIFLD service territories", () => {
    expect(retail.numFeatures).toBe(2931);
  });

  it("exposes the six selectable columns", () => {
    expect(retail.propKeys).toEqual([
      "name", "type", "state", "hold_co", "ctrl_area", "customers",
    ]);
  });

  it("carries no HIFLD text sentinels", () => {
    for (const key of retail.propKeys) {
      const hits = retail.propColumns[key].filter((v) => /not[\s-]*available|^n\/a$/i.test(v));
      expect(`${key}: ${hits.length}`).toBe(`${key}: 0`);
    }
  });

  it("carries no HIFLD negative sentinels in customers", () => {
    const negatives = retail.propColumns.customers.filter((v) => v !== "" && Number(v) < 0);
    expect(negatives).toEqual([]);
  });

  it("leaves unknown values empty rather than guessing", () => {
    // The sentinels are dropped, not backfilled — some rows legitimately have
    // no ownership type, and an empty CSV cell is the honest answer.
    const blankType = retail.propColumns.type.filter((v) => v === "").length;
    expect(blankType).toBeGreaterThan(0);
    expect(retail.propColumns.name.filter((v) => v === "")).toEqual([]);
  });

  /** [place, lon, lat, utility that actually serves it] */
  const COVERAGE: [string, number, number, string][] = [
    ["Honolulu, HI", -157.858, 21.315, "HAWAIIAN ELECTRIC CO INC"],
    ["Los Angeles, CA", -118.243, 34.052, "LOS ANGELES DEPARTMENT OF WATER & POWER"],
    ["Seattle, WA", -122.332, 47.606, "CITY OF SEATTLE - (WA)"],
  ];

  // Asserted as "is among the covering territories", not "is the first match".
  // Territories overlap and this layer is not area-sorted, so first-match is not
  // meaningful here — downtown Seattle also falls inside CITY OF MILTON - (WA),
  // whose upstream HIFLD polygon spans most of Puget Sound. See the note in
  // fetch-retail-territories.mjs.
  it.each(COVERAGE)("%s is covered by its serving utility", (_place, lon, lat, expected) => {
    expect(lookupAll(retail, lon, lat, "name")).toContain(expected);
  });
});
