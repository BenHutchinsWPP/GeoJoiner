/**
 * Spot-checks the shipped Control Areas layer against the real .gjbf asset in
 * public/data, through the real point-in-polygon path.
 *
 * Control areas are the one built-in layer whose polygons genuinely overlap:
 * the federal marketers (WAPA, BPA) blanket dozens of local utilities they
 * wheel power for. Feature order therefore decides what a first-match join
 * returns, and fetch-control-areas.mjs sorts smallest-area-first so the most
 * specific control area wins. Drop that sort and every FIRST_MATCH case below
 * flips to the federal overlay — which is what this file is here to catch.
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

/** Every control area covering the point, in feature order. */
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

const control = load("control-areas.gjbf");

describe("control areas layer", () => {
  it("ships all 71 HIFLD control areas", () => {
    expect(control.numFeatures).toBe(71);
  });

  it("exposes the three selectable columns", () => {
    expect(control.propKeys).toEqual(["NAME", "ID", "STATE"]);
  });

  /** [place, lon, lat, NAME] — the utility that actually dispatches there. */
  const FIRST_MATCH: [string, number, number, string][] = [
    ["Honolulu, HI", -157.858, 21.315, "HAWAIIAN ELECTRIC CO INC"],
    ["Los Angeles, CA", -118.243, 34.052, "LOS ANGELES DEPARTMENT OF WATER AND POWER"],
    ["Las Vegas, NV", -115.139, 36.170, "NEVADA POWER COMPANY"],
    ["El Centro, CA", -115.563, 32.792, "IMPERIAL IRRIGATION DISTRICT"],
    ["Tucson, AZ", -110.974, 32.222, "TUCSON ELECTRIC POWER COMPANY"],
    ["Turlock, CA", -120.847, 37.494, "TURLOCK IRRIGATION DISTRICT"],
    ["Manhattan, NY", -73.985, 40.758, "NEW YORK INDEPENDENT SYSTEM OPERATOR"],
    // Both sit under a federal overlay; the local utility must still win.
    ["Sacramento, CA", -121.494, 38.582, "BALANCING AUTHORITY OF NORTHERN CALIFORNIA"],
    ["Seattle, WA", -122.332, 47.606, "SEATTLE CITY LIGHT"],
  ];

  it.each(FIRST_MATCH)("%s resolves to %s", (_place, lon, lat, expected) => {
    expect(lookup(control, lon, lat, "NAME")).toBe(expected);
  });

  it("keeps the broad federal overlay available behind the local match", () => {
    // Seattle is inside BPA as well as Seattle City Light — the "all" and
    // "join" multiple-match modes depend on the overlay still being there.
    const hits = lookupAll(control, -122.332, 47.606, "NAME");
    expect(hits[0]).toBe("SEATTLE CITY LIGHT");
    expect(hits).toContain("BONNEVILLE POWER ADMINISTRATION");
  });

  it("carries the EIA utility ID alongside the name", () => {
    expect(lookup(control, -122.332, 47.606, "ID")).toBe("16868");
    expect(lookup(control, -122.332, 47.606, "STATE")).toBe("WA");
  });

  it("returns nothing well offshore", () => {
    expect(lookup(control, -140.0, 35.0, "NAME")).toBeNull();
  });
});
