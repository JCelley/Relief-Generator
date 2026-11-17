# Licenses

Everything this tool ships or downloads at runtime is licensed for commercial use.
Checked 2026-11-16 against the Hugging Face model cards / API (`cardData.license`) and each npm package's `package.json`.
Re-check whenever a model or dependency is added or changed.

## AI models (downloaded by the browser on first use, then cached)

| Model | Used for | Hub repo (what we load) | Upstream | License |
|---|---|---|---|---|
| Depth Anything V2 **Small** | depth estimation | `onnx-community/depth-anything-v2-small` | `depth-anything/Depth-Anything-V2-Small` | **Apache-2.0** |
| ormbg | subject mask (lighter alternative / automatic fallback) | `onnx-community/ormbg-ONNX` | `schirrmacher/ormbg` | **Apache-2.0** |
| MODNet | subject mask (portraits) | `Xenova/modnet` | `ZHKKKe/MODNet` | **Apache-2.0** |
| BiRefNet lite | subject mask (default) | `onnx-community/BiRefNet_lite-ONNX` | `ZhengPeng7/BiRefNet` | **MIT** |

Notes:
- **BiRefNet is modified at load time** in the browser: some graph nodes are rewritten into mathematically
  identical forms (`src/models/onnxPatch.ts`) to work around WebGPU limits. MIT permits modification.
- ormbg was trained on synthetic human images (see its model card) and misses non-human subjects
  (it failed on a cat photo and a cartoon in testing), so it is only the fallback.
- `vite.config.ts` patches one line of the bundled onnxruntime-web (MIT) to forward the `enableInt64` WebGPU option.

### Considered and rejected

| Model | Reason |
|---|---|
| Depth Anything V2 Base / Large | CC-BY-NC-4.0 (non-commercial) |
| BRIA RMBG-1.4 / RMBG-2.0 | BRIA license / CC-BY-NC-4.0 (non-commercial) |
| `onnx-community/ISNet-ONNX` | tagged AGPL-3.0 (other conversions of the same weights claim Apache-2.0; too ambiguous for business use) |
| BEN2 (`onnx-community/BEN2-ONNX`) | MIT, but fails on WebGPU (buffer limits) and is 219 MB |
| Full BiRefNet (`onnx-community/BiRefNet_512x512-ONNX`) | MIT, but 473 MB (fp16) — too large for a web app |

## Runtime libraries (bundled into the web app)

| Package | Version | License |
|---|---|---|
| `@huggingface/transformers` (transformers.js) | 4.3.2 | Apache-2.0 |
| `onnxruntime-web` (incl. the WASM runtime copied to `public/ort/`) | 1.31.0-dev | MIT |
| `onnxruntime-common` | 1.30.0 | MIT |
| `@huggingface/jinja` | 0.5.13 | MIT |
| `@huggingface/tokenizers` | 0.2.0 | Apache-2.0 |
| `three` | 0.187.0 | MIT |
| `flatbuffers` | 25.9.23 | Apache-2.0 |
| `protobufjs` | 7.6.6 | BSD-3-Clause |
| `long` | 5.3.2 | Apache-2.0 |
| `guid-typescript` | 1.0.9 | ISC |
| `platform` | 1.3.6 | MIT |

The B-spline fitting and the STEP / STL writers are original code in this repository (no CAD kernel is shipped).

## Development-only tools (not shipped to users)

| Package | Version | License | Notes |
|---|---|---|---|
| `vite` | 8.3.8 | MIT | |
| `typescript` | 7.0.2 | Apache-2.0 | |
| `vitest` | 5.1.0 | MIT | |
| `tsx` | 4.23.15 | MIT | |
| `onnxruntime-node` | 1.30.0 | MIT | runs the models in the tuning harness |
| `sharp` | 0.35.5 | Apache-2.0 | prebuilt binaries include libvips (LGPL-3.0); used only by the harness |
| `occt-import-js` | 0.0.23 | LGPL-2.1 | OpenCascade reader, used only by unit tests to validate STEP output |
| `@types/three`, `@types/node` | — | MIT | |
