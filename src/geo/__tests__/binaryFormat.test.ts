import { describe, it, expect } from "vitest";
import type { FeatureCollection } from "geojson";
import { geoJsonToGjbfBuffer, decodeGjbf, gjbfToFeatureCollection, pointInFeature } from "../binaryFormat";

const fc: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "square" },
      geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] },
    },
    {
      type: "Feature",
      properties: { name: "two-boxes" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
          [[[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]],
        ],
      },
    },
  ],
};

describe("gjbfToFeatureCollection round-trip", () => {
  const data = decodeGjbf(geoJsonToGjbfBuffer(fc));
  const out = gjbfToFeatureCollection(data);

  it("preserves feature count, types and properties", () => {
    expect(out.features.length).toBe(2);
    expect(out.features[0].geometry.type).toBe("Polygon");
    expect(out.features[1].geometry.type).toBe("MultiPolygon");
    expect(out.features[0].properties?.name).toBe("square");
  });

  it("preserves coordinates", () => {
    const poly = out.features[0].geometry as GeoJSON.Polygon;
    expect(poly.coordinates[0][0]).toEqual([0, 0]);
    expect(poly.coordinates[0][2]).toEqual([2, 2]);
    const multi = out.features[1].geometry as GeoJSON.MultiPolygon;
    expect(multi.coordinates.length).toBe(2);
    expect(multi.coordinates[1][0][0]).toEqual([20, 20]);
  });

  it("reconstructed geometry still matches points correctly", () => {
    expect(pointInFeature(1, 1, 0, data)).toBe(true);     // inside square
    expect(pointInFeature(5, 5, 0, data)).toBe(false);    // outside square
    expect(pointInFeature(20.5, 20.5, 1, data)).toBe(true); // inside 2nd box
  });
});
