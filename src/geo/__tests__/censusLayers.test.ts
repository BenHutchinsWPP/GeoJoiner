/**
 * Spot-checks the shipped Census layers end-to-end: the real .gjbf assets in
 * public/data, decoded and queried through the real point-in-polygon path.
 * Catches shapefile→GeoJSON ring-grouping errors and coordinate-quantization
 * regressions, which a synthetic fixture would not.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { decodeGjbf, pointInFeature, type GjbfData } from "../binaryFormat";

const load = (name: string) => {
  const b = readFileSync(join(__dirname, "..", "..", "..", "public", "data", name));
  return decodeGjbf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
};

function lookup(data: GjbfData, lon: number, lat: number, key: string) {
  for (let fi = 0; fi < data.numFeatures; fi++) {
    const o = fi * 4;
    if (lon < data.bboxes[o] || lat < data.bboxes[o + 1] ||
        lon > data.bboxes[o + 2] || lat > data.bboxes[o + 3]) continue;
    if (pointInFeature(lon, lat, fi, data)) return data.propColumns[key][fi];
  }
  return null;
}

/**
 * [landmark, lon, lat, USPS, ZCTA] — spread across CONUS, AK, HI and PR.
 * Expected values cross-checked against GDAL's own spatial filter:
 *   ogrinfo -al -geom=NO -spat <lon> <lat> <lon> <lat> data-src/us-zctas.geojson
 */
const POINTS: [string, number, number, string, string][] = [
  // 20006, not the White House's 20500 mailing ZIP: unique single-delivery-point
  // ZIPs have no ZCTA, since ZCTAs are built only from address-range blocks.
  ["White House", -77.0365, 38.8977, "DC", "20006"],
  ["Space Needle", -122.3493, 47.6205, "WA", "98109"],
  ["Alamo", -98.4861, 29.4260, "TX", "78205"],
  ["Diamond Head", -157.8036, 21.2619, "HI", "96816"],
  ["Anchorage", -149.9003, 61.2181, "AK", "99501"],
  ["San Juan PR", -66.1057, 18.4655, "PR", "00901"],
];

describe("census layers", () => {
  it("states resolve to the right USPS code", () => {
    const d = load("us-states.gjbf");
    expect(d.numFeatures).toBe(56);
    for (const [name, lon, lat, usps] of POINTS) {
      expect(`${name}=${lookup(d, lon, lat, "USPS")}`).toBe(`${name}=${usps}`);
    }
  });

  it("counties resolve, including non-ASCII names", () => {
    const d = load("us-counties.gjbf");
    // 3235, not 3233: the 2025 vintage replaced Connecticut's 8 counties with
    // 9 planning regions and split Alaska's Valdez-Cordova into 2.
    expect(d.numFeatures).toBe(3235);
    expect(lookup(d, -77.0365, 38.8977, "STATEFP")).toBe("11");
    expect(lookup(d, -77.0365, 38.8977, "COUNTY")).toBe("001");
    expect(lookup(d, -122.3493, 47.6205, "NAME")).toBe("King");
    expect(lookup(d, -106.8, 32.3, "NAME")).toBe("Doña Ana");
  });

  it("zctas resolve to the right ZIP", () => {
    const d = load("us-zctas.gjbf");
    // 2020 ZCTAs (ZCTA520). The 2010 set shipped 33144; ZCTAs are decennial, so
    // this number only moves when the layer is rebuilt against a new census.
    expect(d.numFeatures).toBe(33791);
    for (const [name, lon, lat, , zip] of POINTS) {
      expect(`${name}=${lookup(d, lon, lat, "ZCTA5")}`).toBe(`${name}=${zip}`);
    }
  });

  it("points in open ocean match nothing", () => {
    const d = load("us-states.gjbf");
    expect(lookup(d, -140, 35, "USPS")).toBeNull();
  });
});
