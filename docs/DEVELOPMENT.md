# Development

```bash
npm install
npm run dev       # local dev server
npm run build     # production build to dist/
npm run preview   # preview production build
npm test          # vitest
```

Vite + React + TypeScript + Leaflet. Runtime dependencies are `leaflet` (map),
`papaparse` (CSV) and `jszip` (KMZ) — no spatial libraries; the grid index and
point-in-polygon test are hand-rolled and the index is precomputed at build time.

## Data pipeline (build-time)

GeoJSON → binary `.gjbf` (pre-flattened polygon coords, int32 fixed-point at ~11 cm) +
`.grid` (1° spatial index) → served as static assets. Layouts are in
[`BINARY_FORMATS.md`](BINARY_FORMATS.md).

```bash
npm run fetch:census      # Census shapefiles      → data-src/us-*.geojson
npm run fetch:boundaries  # geoBoundaries + NE     → data-src/{countries,admin1}.geojson
npm run fetch:control-areas # HIFLD GeoParquet     → data-src/control-areas.geojson
npm run preprocess        # data-src/*.geojson     → public/data/*.gjbf + .grid
```

Fetch steps are only needed when refreshing their layers; `preprocess.mjs` alone
rebuilds from whatever is already in `data-src/`.

`fetch-census.mjs` requires GDAL (`sudo apt install gdal-bin`), which reads each
shapefile straight out of the remote zip — no download or unzip step. Each layer names
its own release year: states and counties come from GENZ2025, ZCTAs from GENZ2020,
since the release year is not the boundary vintage. The ZCTA source GeoJSON (~165 MB)
is gitignored since it exceeds GitHub's 100 MB file limit — re-run it to restore it.

`fetch-boundaries.mjs` needs no external binaries; it simplifies with mapshaper, which
is already a devDependency. It downloads ~815 MB into the gitignored `data-src/.cache/`
and reuses it, so re-running after the first fetch costs only the simplify pass. Note
that `-simplify dp` is load-bearing: mapshaper's default is Visvalingam, whose
`interval=` is an area threshold with no deviation bound, and at the same file size it
left a p99.9 error of 14.5 km instead of 198 m.

## Data manifest

Built-in layers are described in a machine-readable `public/data/manifest.json`, which
`preprocess.mjs` regenerates. Tools can parse it to discover layers, assets and
properties.

```json
[
  {
    "id": "string",                  // Unique layer identifier (e.g. "country", "state")
    "label": "string",               // Human-readable title
    "sourceUrl": "string",           // Public page documenting the boundary source (optional)
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

## Deployment

Static site. The included GitHub Actions workflow builds and deploys to GitHub Pages
on every push to `main` (one-time setup: Settings → Pages → Source: GitHub Actions).

The app is configured for the `GeoJoiner` repo name. If yours differs, update `base`
in `vite.config.ts` and re-run `node scripts/preprocess.mjs` to regenerate the
manifest URLs.
