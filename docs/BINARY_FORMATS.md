# Binary Serialization Formats

This document describes the binary layouts of the custom formats used by GeoJoiner: `.gjbf` (GeoJSON Binary Format) and `.grid` (Spatial Grid Index). 

Both formats are serialized in **little-endian** byte order.

---

## 1. GeoJSON Binary Format (`.gjbf`)

The `.gjbf` format flattens nested GeoJSON `Polygon` and `MultiPolygon` structures into continuous coordinate arrays, drastically reducing size and parsing overhead (eliminating `JSON.parse` at runtime).

### File Structure (Version 4)

| Offset | Type | Name | Description |
|---|---|---|---|
| `0` | `uint32` | `magic` | File identifier: `0x46424a47` ("GJBF") |
| `4` | `uint32` | `version` | Format version: `4` |
| `8` | `uint32` | `numFeatures` | Total number of features ($N_f$) |
| `12` | `uint32` | `numPolyGroups` | Total number of polygon groups ($N_{pg}$) |
| `16` | `uint32` | `numRings` | Total number of rings ($N_r$) |
| `20` | `uint32` | `numProps` | Number of columns/property keys ($N_p$) |

#### Property Keys Registry
Following the header:
- For each property key (up to $N_p$):
  - `uint32` - Length of key string ($L_{key}$)
  - `char[L_{key}]` - UTF-8 encoded property key string

#### Feature Bounding Boxes
- `Float64Array` of size $N_f \times 4$ containing the bounding box coordinates for each feature:
  `[minLon, minLat, maxLon, maxLat]`

#### Property Values (Column-Major)
To allow zero-copy lookups:
- For each property key in the registry (up to $N_p$):
  - For each feature (up to $N_f$):
    - `uint32` - Length of value string ($L_{val}$)
    - `char[L_{val}]` - UTF-8 encoded property value string

#### Topology Offsets
- **`polyGroupStart`**: `uint32` array of size $N_f + 1$. Defines the indices of polygon groups belonging to each feature. The polygon groups for feature $i$ start at `polyGroupStart[i]` and end at `polyGroupStart[i+1]`.
- **`ringGroupStart`**: `uint32` array of size $N_{pg} + 1$. Defines the indices of rings belonging to each polygon group. The rings for polygon group $j$ start at `ringGroupStart[j]` and end at `ringGroupStart[j+1]`.
- **`ringToFeature`**: `uint32` array of size $N_r$. Maps each ring back to its feature index.

#### Coordinate Data
For each ring $k \in [0, N_r-1]$:
- `uint32` - Number of coordinates in this ring ($C_k$)
- `Int32Array` of size $C_k \times 2$ containing `[lon, lat, lon, lat, ...]` coordinate pairs,
  in **scaled fixed-point units** (see below).

#### Coordinate Scaling (Version 4+)
Ring coordinates and ring bounding boxes are stored as `int32` degrees multiplied by
`COORD_SCALE = 1e6`, halving coordinate storage versus `Float64` for a quantization
error of at most $5 \times 10^{-7}$ degrees (~5.5 cm). The extreme value $\pm180°$ maps to
$\pm1.8 \times 10^8$, well inside the `int32` range.

Point-in-polygon runs directly in these scaled units — the query point is quantized once
per feature rather than dequantizing every ring — so intermediate products stay below
$2^{53}$ and are represented exactly by the doubles JavaScript reads out of an `Int32Array`.
Only map display converts back to degrees. Note that **feature** bounding boxes remain
`Float64` degrees, since the spatial grid indexes them in degree space.

#### Ring Bounding Boxes
- `Int32Array` of size $N_r \times 4$. Bounding boxes for each ring:
  `[minLon, minLat, maxLon, maxLat]` (used for outer/hole ring bounding-box early
  pruning). Computed from the already-quantized ring, so the prune can never reject a
  point that the full ring test would have accepted.

---

## 2. Spatial Grid Index (`.grid`)

The `.grid` format encodes a 1° × 1° spatial lookup table, with adaptive 0.2° sub-cell refinements for cells exceeding a candidate density threshold.

### File Structure (Version 2)

| Offset | Type | Name | Value / Description |
|---|---|---|---|
| `0` | `uint32` | `magic` | File identifier: `0x44495247` ("GRID") |
| `4` | `uint32` | `version` | Format version: `2` |
| `8` | `double` | `cellSize` | Size of base cell (always `1.0` degree) |
| `16` | `double` | `originLat` | Bottom-left origin latitude (always `-90.0`) |
| `24` | `double` | `originLon` | Bottom-left origin longitude (always `-180.0`) |
| `32` | `uint32` | `numLat` | Rows count (always `180`) |
| `36` | `uint32` | `numLon` | Columns count (always `360`) |
| `40` | `uint32` | `nonEmpty` | Number of non-empty base cells |

### Grid Table Lookup
Immediately following the header is the base grid lookup table:
- **`gridTable`**: `uint32` array of size $180 \times 360 = 64,800$.
- Each entry is an index/offset into the `flatFeatures` array.
- Empty cells have an offset of `0xFFFFFFFF`.

### Flat Feature Buffers (`flatFeatures`)
The rest of the file is a continuous `uint32` array containing candidate feature listings:

#### A. Normal Cell Entry
If the cell does not need refinement (feature count $\le$ threshold):
- `flatFeatures[offset]` = Candidate Count ($C$)
- `flatFeatures[offset + 1 ... offset + C]` = Feature Indices ($fi_0, fi_1, ... fi_{C-1}$)

#### B. Refined Cell Entry
If the cell is dense (feature count $>$ threshold, marked by count `0`):
- `flatFeatures[offset]` = `0` (refined cell marker)
- `flatFeatures[offset + 1]` = Sub-divisions count ($S_{div}$, e.g. `5` for 0.2° sub-cells)
- `flatFeatures[offset + 2]` = Sub-table size ($S_{sz} = S_{div} \times S_{div}$)
- `flatFeatures[offset + 3 ... offset + 2 + S_{sz}]` = Sub-cell offsets relative to the start of this refined cell's sub-data (empty sub-cells = `0xFFFFFFFF`).
- `flatFeatures[offset + 3 + S_{sz} ...]` = Sub-cell feature lists. Each sub-cell list starts with its local count, followed by feature indices, identical to a normal cell layout.
