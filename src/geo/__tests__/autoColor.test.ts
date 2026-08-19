/**
 * The map colours polygons per feature and colours each point to match the
 * polygon it landed in. Neither side re-runs point-in-polygon: both hash the
 * same string, so the colours only line up as long as that hash is stable and
 * the point's joined value is reduced to the same string the polygon carries.
 */
import { describe, it, expect } from "vitest";
import { autoColor, deriveOutputColumns } from "../layerConfig";
import type { PropertyOption } from "../types";

describe("autoColor", () => {
  it("is stable for the same value", () => {
    expect(autoColor("SEATTLE CITY LIGHT")).toBe(autoColor("SEATTLE CITY LIGHT"));
  });

  it("always returns a hex colour, including for the empty string", () => {
    for (const v of ["", "A", "SEATTLE CITY LIGHT", "x".repeat(500), "Doña Ana"]) {
      expect(autoColor(v)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("separates values differing only in the last character", () => {
    // charCodeAt-sum hashes put these in adjacent buckets; FNV-1a should not.
    const colors = new Set(["DISTRICT 1", "DISTRICT 2", "DISTRICT 3", "DISTRICT 4"].map(autoColor));
    expect(colors.size).toBeGreaterThan(1);
  });

  it("spreads a realistic set of names across most of the palette", () => {
    const names = Array.from({ length: 200 }, (_, i) => `UTILITY DISTRICT ${i}`);
    expect(new Set(names.map(autoColor)).size).toBeGreaterThan(10);
  });
});

describe("point / polygon colour agreement", () => {
  const properties: PropertyOption[] = [
    { key: "NAME", label: "Name" },
    { key: "ID", label: "EIA ID" },
  ];

  /** Mirrors MapPanel: colour by the first selected property's output column. */
  const columnFor = (keys: string[]) =>
    deriveOutputColumns("Control_Area", properties, keys)
      .find((o) => o.propertyKey === keys[0])!.outputColumn;

  it("a point matching one polygon takes that polygon's colour", () => {
    const col = columnFor(["NAME"]);
    const row = { [col]: "SEATTLE CITY LIGHT" };
    expect(autoColor(row[col].split("; ")[0])).toBe(autoColor("SEATTLE CITY LIGHT"));
  });

  it("under join mode a point takes the FIRST match's colour", () => {
    // "join" is the default multiple-match mode, so an overlapped point carries
    // every containing polygon. Feature order decides which one is drawn as the
    // most specific, and the point must follow that same one.
    const col = columnFor(["NAME"]);
    const row = { [col]: "SEATTLE CITY LIGHT; BONNEVILLE POWER ADMINISTRATION" };
    // The joined string must be reduced to the first match before hashing.
    // Asserting on the split value rather than on two colours differing: with
    // an 18-entry palette any two strings collide roughly 1 time in 18, so a
    // "these colours differ" assertion is flaky by construction.
    expect(row[col].split("; ")[0].trim()).toBe("SEATTLE CITY LIGHT");
    expect(autoColor(row[col].split("; ")[0].trim())).toBe(autoColor("SEATTLE CITY LIGHT"));
  });

  it("colours by the selected property, not always the default one", () => {
    // Selecting only ID means the row has no NAME column to colour by; the
    // column MapPanel resolves must follow the selection.
    expect(columnFor(["ID"])).not.toBe(columnFor(["NAME"]));
  });
});
