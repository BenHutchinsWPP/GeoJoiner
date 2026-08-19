# GeoJoiner

**Browser-based point-in-polygon enrichment.** No server. No upload. Free.

Live at: [GeoJoiner](https://benhutchinswpp.github.io/GeoJoiner/)

[![MIT License](https://img.shields.io/badge/License-MIT-lightgrey.svg)](https://opensource.org/licenses/MIT)

Select a CSV with lat/lon coordinates → pick the lat/lon columns → select boundary
layers (or add your own GeoJSON/KML) → **Run GeoJoin** → download the enriched CSV.
Everything runs in a Web Worker in your browser; 100k+ rows without freezing the UI.

Built-in layers: countries, states/provinces, US states, US counties, US ZCTAs, NERC
regions, control areas, balancing authorities, utility retail territories.

```bash
npm install
npm run dev
```

## Docs

- [Data sources](docs/DATA_SOURCES.md) — layer provenance, accuracy, caveats, attribution
- [Development](docs/DEVELOPMENT.md) — build, data pipeline, manifest, deployment
- [Binary formats](docs/BINARY_FORMATS.md) — `.gjbf` and `.grid` layouts

## License

MIT. Boundary data is public domain or CC BY 4.0 — see
[attribution](docs/DATA_SOURCES.md#attribution-and-credits).

This project was scoped by Ben Hutchins (WPP) and developed with an AI-assisted development workflow.
