# Data Sources

Built-in boundary layers, where they come from, and what they get wrong.

| Layer | Source | Default Property | Served Size |
|-------|--------|------------------|------------|
| **Administrative** | | | |
| Countries (geoBoundaries CGAZ ADM0) | geoBoundaries CGAZ ADM0 + Natural Earth territories | `ADMIN` | 10.5 MB |
| States / Provinces (geoBoundaries CGAZ ADM1) | geoBoundaries CGAZ ADM1 | `name` | 14.0 MB |
| US States (Census 2025 500k) | US Census `cb_2025_us_state_500k` | `NAME` | 2.5 MB |
| US Counties (Census 2025 500k) | US Census `cb_2025_us_county_500k` | `NAME` | 8.5 MB |
| ZIP Codes / ZCTA (Census 2020 500k) | US Census `cb_2020_us_zcta520_500k` | `ZCTA5` | 51.1 MB |
| **Electrical** | | | |
| NERC Regions (HIFLD) | HIFLD via Source Cooperative | `NERC_Label` | 1.2 MB |
| Control Areas (HIFLD) | HIFLD via Source Cooperative | `NAME` | 1.9 MB |
| Balancing Authorities (EIA) | EIA Atlas | `BAL_AUTH` | 2.4 MB |
| Utility Retail Territories (HIFLD) | HIFLD via Source Cooperative | `name` | 6.8 MB |

*Served size = preprocessed binary (`.gjbf`) + spatial grid (`.grid`), before HTTP
compression. Layers are fetched only when selected, then cached in IndexedDB for 24h.*

## Global layers

The two global layers come from **geoBoundaries CGAZ**, a composite of per-country
authoritative sources (US Census for the USA, StatCan for Canada, INEGI for Mexico)
with ADM0 clipped to the US State Department's LSIB. They are simplified to a
Douglas-Peucker tolerance of 200 m, which bounds the worst-case border error at
roughly that distance. Measured along the US national outline against the
full-resolution source (~112k sample vertices, distance from each true vertex to the
shipped boundary):

| Layer | median | p90 | p99.9 |
|-------|--------|-----|-------|
| Natural Earth 110m *(previously used here)* | 7,552 m | 50,191 m | 181,539 m |
| Natural Earth 10m | 571 m | 1,575 m | 11,678 m |
| **CGAZ at dp 200 m** | **41 m** | **132 m** | **198 m** |

Admin-1 covers **3,224 units across 218 countries**; the Natural Earth 50m layer it
replaced held 294 units across 9. CGAZ is sovereign-state level, so it folds
dependencies into their parent — Hong Kong reads "China", Bermuda reads "United
Kingdom". 39 Natural Earth territory polygons are appended to keep those named
separately, and they are ordered *before* their parent so first-match wins.

## US Census layers

The three US Census layers use the **1:500,000 cartographic boundary** series — the
highest-resolution generalized boundaries Census publishes for web use. Coordinates
stay in the source NAD83 datum (EPSG:4269), which differs from WGS84 by roughly 1–2 m
in CONUS, an order of magnitude below the series' own ~150 m generalization.

> **ZCTAs are not ZIP codes.** They are Census tabulation areas approximating ZIP
> delivery routes, built only from address-range blocks. ZIPs assigned to a single
> delivery point or to PO boxes have no ZCTA at all — the White House's `20500`, for
> instance, is absent, and that location falls inside ZCTA `20006`.
>
> There is no authoritative alternative: USPS publishes no ZIP polygons, because a
> ZIP code is a set of delivery points along street segments rather than an area.
> Every ZIP polygon product is a derived approximation. Commercial sets (Precisely,
> Esri, Melissa) build theirs from carrier-route data and do cover PO box and point
> ZIPs, but their licences forbid redistributing the geometry, which a browser-based
> tool necessarily does.
>
> ZCTAs are decennial. This is the 2020 set (`ZCTA520`); Census stopped shipping
> ZCTAs in the cartographic boundary series after GENZ2020, so there is nothing
> newer until the 2030 census.

> **Connecticut has no counties.** The state abolished county government, and from
> the 2025 vintage Census tabulates 9 Councils of Governments as county equivalents
> instead — `Capitol`, `Naugatuck Valley`, `Northwest Hills` and so on, with new FIPS
> codes in the `091xx` range. Joining CT points against the county layer returns those
> names, not Fairfield or Hartford.

## Control Areas overlap

Every other built-in layer tessellates — one polygon per point. Control areas do not:
the federal power marketers (WAPA, BPA) blanket dozens of the local utilities they
wheel power for, so a point in Seattle sits inside both Seattle City Light and
Bonneville Power Administration. Because no single answer is right, the
multiple-match default is **join** — every containing polygon is emitted, separated
by `; `. Features are sorted smallest-area-first, so the most specific control area
comes first in that list, and switching to **keep first** returns it alone. The
source is HIFLD's GeoParquet republication, simplified to the same 200 m
Douglas-Peucker tolerance as the geoBoundaries layers — 2.28 M vertices across 71
features at full resolution, almost all of it coastline detail.

## Attribution and credits

- Countries and Admin-1: [geoBoundaries](https://www.geoboundaries.org/) CGAZ, William & Mary geoLab (CC BY 4.0), with ADM0 clipped to the [US State Department LSIB](https://geodata.state.gov/) (Public Domain)
- US States / Counties: [US Census Bureau cartographic boundary files](https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html), 2025 500k series (Public Domain)
- US ZCTAs: [US Census Bureau cartographic boundary files](https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html), 2020 500k series (Public Domain)
- Balancing Authorities: [U.S. Energy Information Administration](https://atlas.eia.gov/) (Public Domain)
- Utility Retail Territories: HIFLD, republished as GeoParquet by SeerAI on [Source Cooperative](https://source.coop/seerai/hifld/electric-retail-service-territories/retail-service-territories) (Public Domain)
- NERC Regions: HIFLD, republished as GeoParquet by SeerAI on [Source Cooperative](https://source.coop/seerai/hifld/nerc-regions/nerc-regions-subregions) (Public Domain)
- Dependent territories and country attributes (ISO 3166 codes, continent): [Natural Earth 10m](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/) (Public Domain)
- Control Areas: HIFLD, republished as GeoParquet by SeerAI on [Source Cooperative](https://source.coop/seerai/hifld/control-areas/control-areas) (Public Domain)
- HIFLD was retired in August 2025. Its layers here reference the [SeerAI Source Cooperative archive](https://source.coop/seerai/hifld) rather than the defunct GeoPlatform hub pages.
- Map tiles: [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Map library: [Leaflet](https://leafletjs.com/) (BSD 2-Clause)
- CSV parsing: [PapaParse](https://www.papaparse.com/) (MIT)
