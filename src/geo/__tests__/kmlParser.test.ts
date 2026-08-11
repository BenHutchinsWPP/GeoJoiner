import { describe, it, expect } from "vitest";
import { parseKml } from "../kmlParser";

const SAMPLE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Square</name>
      <ExtendedData>
        <Data name="region"><value>test_a</value></Data>
      </ExtendedData>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
              -100,40  -90,40  -90,30  -100,30  -100,40
            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
    <Placemark>
      <name>Square With Hole</name>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>-80,40 -70,40 -70,30 -80,30 -80,40</coordinates>
          </LinearRing>
        </outerBoundaryIs>
        <innerBoundaryIs>
          <LinearRing>
            <coordinates>-77,37 -73,37 -73,33 -77,33 -77,37</coordinates>
          </LinearRing>
        </innerBoundaryIs>
      </Polygon>
    </Placemark>
    <Placemark>
      <name>Multi</name>
      <MultiGeometry>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>-60,40 -50,40 -50,30 -60,30 -60,40</coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>-60,25 -50,25 -50,15 -60,15 -60,25</coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>
      </MultiGeometry>
    </Placemark>
  </Document>
</kml>`;

describe("kmlParser", () => {
  it("parses a simple KML with 3 placemarks", () => {
    const result = parseKml(SAMPLE_KML);
    expect(result.featureCount).toBe(3);
    expect(result.geojson.type).toBe("FeatureCollection");
    expect(result.geojson.features.length).toBe(3);
  });

  it("extracts properties from name and ExtendedData", () => {
    const result = parseKml(SAMPLE_KML);
    const square = result.geojson.features.find(
      (f) => f.properties?.["Name"] === "Square",
    );
    expect(square).toBeDefined();
    expect(square!.properties?.["region"]).toBe("test_a");
  });

  it("parses names into properties", () => {
    const result = parseKml(SAMPLE_KML);
    const names = result.geojson.features.map((f) => f.properties?.["Name"]);
    expect(names).toContain("Square");
    expect(names).toContain("Square With Hole");
    expect(names).toContain("Multi");
  });

  it("returns MultiGeometry as MultiPolygon type", () => {
    const result = parseKml(SAMPLE_KML);
    const multi = result.geojson.features.find(
      (f) => f.properties?.["Name"] === "Multi",
    );
    expect(multi!.geometry.type).toBe("MultiPolygon");
    expect((multi!.geometry as any).coordinates.length).toBe(2);
  });

  it("closes rings automatically", () => {
    const result = parseKml(SAMPLE_KML);
    const square = result.geojson.features.find(
      (f) => f.properties?.["Name"] === "Square",
    );
    const coords = (square!.geometry as any).coordinates[0];
    const first = coords[0];
    const last = coords[coords.length - 1];
    expect(first[0]).toBe(last[0]);
    expect(first[1]).toBe(last[1]);
  });

  it("reports warnings for placemarks with no polygon geometry", () => {
    const mixed = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark>
    <name>Valid</name>
    <Polygon>
      <outerBoundaryIs>
        <LinearRing><coordinates>0,0 1,0 1,1 0,1 0,0</coordinates></LinearRing>
      </outerBoundaryIs>
    </Polygon>
  </Placemark>
  <Placemark>
    <name>NoGeo</name>
    <description>just text, no geometry</description>
  </Placemark>
</kml>`;
    const result = parseKml(mixed);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("NoGeo");
    expect(result.featureCount).toBe(1);
  });

  it("throws on KML with no Placemark elements", () => {
    expect(() => parseKml("<foo><bar/></foo>")).toThrow("No Placemark");
  });

  it("throws on invalid XML", () => {
    expect(() =>
      parseKml("<?xml version='1.0'?><kml><unclosed>"),
    ).toThrow("Invalid XML");
  });

  it("handles KML without Document wrapper (Placemarks under <kml>)", () => {
    const noDoc = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark>
    <name>Direct</name>
    <Polygon>
      <outerBoundaryIs>
        <LinearRing><coordinates>0,0 1,0 1,1 0,1 0,0</coordinates></LinearRing>
      </outerBoundaryIs>
    </Polygon>
  </Placemark>
</kml>`;
    const result = parseKml(noDoc);
    expect(result.featureCount).toBe(1);
    expect(result.geojson.features[0].properties?.["Name"]).toBe("Direct");
  });
});