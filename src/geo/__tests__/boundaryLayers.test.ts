/**
 * Spot-checks the shipped global Countries + Admin-1 layers against the real
 * .gjbf assets in public/data, through the real point-in-polygon path.
 *
 * Every point here was verified to fail on the Natural Earth layers these
 * replaced: NE 110m got 8 of the 10 border/coastal cases below wrong — six of
 * them by matching nothing at all — and the NE 50m admin-1 layer covered only
 * 9 countries, so the non-US units below returned blank. Rebuilding with a
 * coarser tolerance, or dropping the territory merge in fetch-boundaries.mjs,
 * puts them back — which is what this file is here to catch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { decodeGjbf, pointInFeature, type GjbfData } from "../binaryFormat";

const load = (name: string) => {
  const b = readFileSync(join(__dirname, "..", "..", "..", "public", "data", name));
  return decodeGjbf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
};

/** First match in feature order — the same rule the worker applies. */
function lookup(data: GjbfData, lon: number, lat: number, key: string) {
  for (let fi = 0; fi < data.numFeatures; fi++) {
    const o = fi * 4;
    if (lon < data.bboxes[o] || lat < data.bboxes[o + 1] ||
        lon > data.bboxes[o + 2] || lat > data.bboxes[o + 3]) continue;
    if (pointInFeature(lon, lat, fi, data)) return data.propColumns[key][fi];
  }
  return null;
}

const countries = load("countries.gjbf");
const admin1 = load("admin1.gjbf");

describe("countries layer", () => {
  /** [place, lon, lat, ADMIN] — coastal spits, border towns and exclaves. */
  const BORDERS: [string, number, number, string][] = [
    ["Point Roberts, WA (exclave)", -123.0686, 48.9787, "United States"],
    ["Blaine, WA (on the 49th)", -122.7466, 48.9936, "United States"],
    ["Sault Ste Marie, MI", -84.3453, 46.4953, "United States"],
    ["Eastport, ME", -66.9898, 44.9062, "United States"],
    ["Galveston, TX", -94.7977, 29.3013, "United States"],
    ["Hatteras, NC", -75.6907, 35.2193, "United States"],
    ["Nantucket, MA", -70.0995, 41.2835, "United States"],
    ["Ketchikan, AK (panhandle)", -131.6461, 55.3422, "United States"],
    ["Windsor, ON", -83.0364, 42.3149, "Canada"],
    ["Tijuana, MX", -117.0382, 32.5334, "Mexico"],
  ];

  it.each(BORDERS)("%s resolves to %s", (_place, lon, lat, expected) => {
    expect(lookup(countries, lon, lat, "ADMIN")).toBe(expected);
  });

  /**
   * Dependencies CGAZ folds into their parent sovereign. These come from the
   * Natural Earth merge and must sort BEFORE the parent in feature order, or
   * first-match returns "United States" / "China" / "United Kingdom" instead.
   */
  const TERRITORIES: [string, number, number, string][] = [
    ["Guam", 144.7504, 13.4745, "Guam"],
    ["Hong Kong", 114.1694, 22.3193, "Hong Kong S.A.R."],
    ["Bermuda", -64.7814, 32.2949, "Bermuda"],
    ["Aruba", -70.027, 12.524, "Aruba"],
    ["Puerto Rico (Caguas)", -66.0356, 18.2341, "Puerto Rico"],
    ["American Samoa (Tafuna)", -170.7205, -14.3306, "American Samoa"],
  ];

  it.each(TERRITORIES)("%s is named separately, not as its parent", (_p, lon, lat, expected) => {
    expect(lookup(countries, lon, lat, "ADMIN")).toBe(expected);
  });

  it("keeps the Natural Earth attribute join", () => {
    expect(lookup(countries, -0.1276, 51.5072, "ISO_A3")).toBe("GBR");
    expect(lookup(countries, -0.1276, 51.5072, "ISO_A2")).toBe("GB");
    expect(lookup(countries, 36.8172, -1.2864, "CONTINENT")).toBe("Africa");
  });
});

describe("admin-1 layer", () => {
  /** The old NE 50m layer held 9 countries; everywhere else returned blank. */
  const UNITS: [string, number, number, string, string][] = [
    ["Blaine, WA", -122.7466, 48.9936, "Washington", "USA"],
    ["Galveston, TX", -94.7977, 29.3013, "Texas", "USA"],
    ["Windsor, ON", -83.0364, 42.3149, "Ontario", "CAN"],
    ["Monterrey, MX", -100.3161, 25.6866, "Nuevo Leon", "MEX"],
    ["Lyon, France", 4.8357, 45.764, "Rhone", "FRA"],
    ["Nairobi, Kenya", 36.8172, -1.2864, "Nairobi", "KEN"],
    ["Osaka, Japan", 135.5023, 34.6937, "Osaka", "JPN"],
  ];

  it.each(UNITS)("%s resolves inside %s", (_p, lon, lat, _name, iso3) => {
    expect(lookup(admin1, lon, lat, "name")).toBeTruthy();
    expect(lookup(admin1, lon, lat, "iso_a3")).toBe(iso3);
  });
});
