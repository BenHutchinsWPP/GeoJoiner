# GeoJoiner

**Browser-based point-in-polygon enrichment.** No server. No upload. Free.

[![CC BY 4.0](https://img.shields.io/badge/License-CC_BY_4.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

Upload a CSV with lat/lon coordinates → select GeoJSON boundary layers → get matched properties for every point.

## Quick Start

1. Upload CSV (or use sample data)
2. Pick which columns are latitude/longitude
3. Select GeoJSON boundary layers (Countries, US States, Counties, etc.)
4. Upload custom GeoJSON if needed
5. Click **Run GeoJoin**
6. Download enriched CSV

## How It Works

- All processing happens in a browser Web Worker
- Uses **1° × 1° spatial grid index** for O(1) candidate lookup
- Custom fast ring-walking ray casting point-in-polygon (no library dependencies)
- Preprocessed binary format (`.gjbf` + `.grid`) for instant layer loading
- Handles 100k+ rows without freezing the UI
- Map shows your points + boundary layers with Leaflet

## Built-in Layers

| Layer | Source | Default Property | Served Size |
|-------|--------|------------------|------------|
| Countries | Natural Earth 110m | `ADMIN` | 853 KB |
| US States | US Census TIGER/Line | `NAME` | 1.8 MB |
| US Counties | US Census TIGER/Line | `NAME` | 2.2 MB |
| Balancing Authorities | EIA via ArcGIS | `BAL_AUTH` | 4.4 MB |
| NERC Regions | HIFLD via ArcGIS | `NERC_Label` | 2.3 MB |
| Admin-1 (Provinces/States) | Natural Earth 50m | `name` | 1.5 MB |
| Utility Retail Territories | EIA / Homeland Security | `name` | 13.4 MB |

*Served size = preprocessed binary (`.gjbf`) + spatial grid (`.grid`). Roughly 50% smaller than raw GeoJSON.*


## Tech Stack

Vite + React + TypeScript + Leaflet

### Dependencies (runtime)
- `leaflet` — Map display
- `papaparse` — CSV parsing

No spatial libraries at runtime. Spatial index is precomputed at build time.

### Data Pipeline (build-time)
GeoJSON → binary `.gjbf` (pre-flattened polygon coords) + `.grid` (1° spatial index) → served as static assets. Run `node scripts/preprocess.mjs` to regenerate.

## Development

```bash
npm install
npm run dev       # local dev server
npm run build     # production build to dist/
npm run preview   # preview production build
```

## Deployment

GeoJoiner is designed to deploy as a static site. A GitHub Actions workflow
is included — push to `main` and it builds + deploys to GitHub Pages
automatically.

```bash
# One-time: enable GitHub Pages in your repo settings
# Settings → Pages → Source: GitHub Actions

# Push and let CI handle it:
git push origin main
```

The app is configured for the `GeoJoiner` repo name. If yours differs,
update `base` in `vite.config.ts` to match your repo name:

```ts
export default defineConfig({
  base: "/YOUR-REPO-NAME/",
  ...
});
```

Then regenerate the data manifest URLs (they live in `public/data/manifest.json`):

```bash
node scripts/preprocess.mjs
```

## Data Manifest Specification

The built-in boundary layers served by the application are described in a machine-readable JSON format at `public/data/manifest.json`. Agents and tools can parse this file to dynamically discover available layers, their assets, and properties.

### Schema Structure

```json
[
  {
    "id": "string",                  // Unique layer identifier (e.g. "country", "state")
    "label": "string",               // Human-readable title
    "url": "string",                 // Path to raw GeoJSON file (optional/reference)
    "gjbfUrl": "string",             // Path to preprocessed .gjbf binary file
    "gridUrl": "string",             // Path to preprocessed .grid spatial index file
    "translationUrl": "string",      // Path to short-to-long translation CSV (optional)
    "defaultPropertyKey": "string",  // Default column property to extract on match
    "properties": [                  // Selectable properties metadata
      {
        "key": "string",             // Raw property key in .gjbf
        "label": "string",           // Friendly column name
        "example": "string"          // Example value
      }
    ],
    "translatedFrom": "string",      // Code source field (optional, e.g. "USPS")
    "translatedTo": "string",        // Label destination field (optional, e.g. "NAME")
    "suggestion": "string",          // Default header suffix for joined columns
    "color": "string"                // HEX color code for map display
  }
]
```

## Data Attribution and Credits


- Countries: [Natural Earth](https://www.naturalearthdata.com/) (Public Domain)
- US States/Counties: [US Census Bureau](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html) via [eric.clst.org](https://eric.clst.org/tech/usgeojson/) (Public Domain)
- Balancing Authorities: [U.S. Energy Information Administration](https://atlas.eia.gov/) (Public Domain)
- NERC Regions: [HIFLD / GeoPlatform](https://hifld-geoplatform.hub.arcgis.com/) (Public Domain)
- Admin-1 (Provinces/States): [Natural Earth Admin-1](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/) (Public Domain)
- Map tiles: [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Map library: [Leaflet](https://leafletjs.com/) (BSD 2-Clause)
- CSV parsing: [PapaParse](https://www.papaparse.com/) (MIT)

This project was scoped by Ben Hutchins (WPP) and developed with an AI-assisted development workflow. 
