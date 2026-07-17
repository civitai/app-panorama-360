# 360° Panorama Studio

A Civitai App (full-page block) that generates **seamless 360° equirectangular
panoramas** with a customComfy workflow on the Civitai orchestrator and lets you
stand inside the result with an embedded [Photo Sphere Viewer](https://photo-sphere-viewer.js.org/).

Built with Vite + TypeScript + **vanilla web components** — no framework. The
Civitai Apps platform contract is postMessage, so `@civitai/app-sdk/blocks`
(types) and the plain-TS `IframeTransport`/`sendTypedRequest` classes from
`@civitai/blocks-react` are all it needs; React exists only as an inert dev
dependency for the SDK's mock-host testing barrel.

## How the panorama works

Technique from the classic A1111/ComfyUI seamless-pano recipe:

- **SDXL checkpoint** (Juggernaut XL Ragnarok, `urn:air:sdxl:checkpoint:civitai:133005@1759168`)
- **360Redmond LoRA** (`urn:air:sdxl:lora:civitai:118025@143197`, strength 0.6) with
  trigger words `360, 360view` prefixed to the prompt
- **2:1 canvas** (2048×1024) sampled with **x-axis-only circular conv padding**
  so the left/right edges are continuations of each other:
  - `SeamlessTile` (model patch) + `MakeCircularVAE` → stock `VAEDecode`
  - from `comfyui-seamless-tiling` (comfyregistry `spinagon/comfyui-seamless-tiling@1.0.0`),
    installed on the worker via the orchestrator's **nodepack snapshot → install-layer** flow

Verified seam quality: the wrap-edge column difference measures ~1.1× the
interior adjacent-column baseline (≈ seamless; a standard generation measures
5–20× there).

### ⚠️ Pack gotcha (why the graph looks the way it does)

The registry build of the seamless pack deep-copies the model/VAE on its
"Make a copy" branches, and modern ComfyUI model objects **crash** under
`copy.deepcopy` (`TypeError: 'NoneType' object is not callable` in
`__setstate__`). Every seamless node in the graph therefore uses
**"Modify in place"**, and `CircularVAEDecode` (which always deep-copies, no
in-place option) is avoided in favor of `MakeCircularVAE` + stock `VAEDecode`.
Safe in a one-shot job container.

## Two generation modes

| Mode | Submit body | Runs where | Seam |
|------|-------------|-----------|------|
| **Seamless wrap** | proposed `kind: 'pano360'` → customComfy template | dev `dev:orch` harness today; embedding on civitai.com needs the block bridge to grow a `pano360` kind (same "shipping for real" gap as illusion-factory) | none (wrapped) |
| **Standard** | `kind: 'textToImage'` (checkpoint + LoRA, 2048×1024 — within the bridge caps) | works through the real block bridge today | visible where the edges meet |

Both modes share one UI, poll loop, and viewer; the app auto-disables the
seamless toggle when the host can't run it.

## The run experience — `@civitai/comfy-run-kit`

The live run UX (queue position → "downloading models N%" → real sampler
step progress from the worker's trace, a ticking Buzz cost meter, worker-log
panel, live previews when the worker emits them, and a **Cancel** button that
does a real mid-render interrupt billed for elapsed GPU time only) lives in
[`packages/comfy-run-kit`](packages/comfy-run-kit/README.md) — a reusable
workspace package: framework-free headless core + `<civitai-comfy-run>` custom
elements, designed for other Civitai apps to adopt. See its README for the
architecture (gateways, trace-blob decoding, buzz-meter anchoring semantics)
and the `RunDetail` bridge-enrichment seam.

## Running it

```bash
npm install

npm run dev:harness   # MOCK host — synthetic, no Buzz, safe to spam
npm run dev:orch      # REAL prod orchestrator — seamless mode, SPENDS REAL BUZZ
npm run dev:live      # real Civitai backend via a dev block token (hosted mode only)
npm run test          # vitest: node (logic) + jsdom (components) projects
npm run build         # typecheck + production bundle (dist/)
```

### 💸 Cost (dev:orch / production)

customComfy is **post-paid at 1 Buzz per GPU-second** — a 2048×1024 30-step
panorama lands around **30–90 Buzz** (measured: 45). The first seamless run also
captures the custom-node install layer (a one-time snapshot step, cached
server-side; the layer AIR is then cached in localStorage so later runs submit
single-step). `dev:orch` resolves its API token from `CIVITAI_ORCH_TOKEN` or the
dev-stack's `.mcp.json` — generations bill **that token owner's account**.

### Dev-harness modes

- `mock` — the SDK mock host (`@civitai/blocks-react/testing`); URL knobs like
  `?balance=5&latency=2000&failNext=1` still work.
- `orch` — mock host for init/consent/balance + `src/orch-host.ts` answering the
  three workflow messages with real `POST/GET /v2/consumer/workflows` calls
  through the vite `/orch` proxy (token injected server-side, never bundled).
  This module is the reference implementation of the translation the platform
  bridge would own for a real `pano360` kind.
- `live` — the SDK live host with a dev block token (`VITE_LIVE_BLOCK_TOKEN`,
  see `.env.example`); the real bridge only accepts `textToImage`, so seamless
  is disabled here.

## Layout

| File | What |
|------|------|
| `packages/comfy-run-kit/` | The reusable run-experience kit (headless run controller, trace tailer, buzz meter, gateways, `<civitai-*>` elements) |
| `src/panorama.ts` | Domain: AIRs, presets, hosted body, seamless customComfy template (2-step snapshot/$ref or single-step cached-layer, `trace: "binary"`), node labels |
| `src/nodepack.ts` | Install-layer AIR cache (localStorage + in-memory fallback for the sandboxed iframe) |
| `src/controller.ts` | App wrapper: estimate + Buzz-error classification + gallery accumulation, delegating submit → terminal to the kit's `RunController` |
| `src/transport.ts` | Framework-free typed bridge over the SDK transport (estimate, consent, balance, resize) + the kit `BridgeGateway` |
| `src/generation.ts` | Phases, Buzz-error classification, formatting |
| `src/components/` | `<pano-app>` shell, `<pano-controls>`, `<pano-status>` (app alerts + embedded `<civitai-comfy-run>`), `<pano-viewer>` (PSV lifecycle + `<img>` CORS fallback), `<pano-gallery>` |
| `src/harness.ts`, `src/orch-host.ts`, `src/dev-transport.ts` | Dev harness (vanilla); orch-host intercepts SUBMIT/POLL/**CANCEL**/BALANCE and attaches the `RunDetail` enrichment |
| `block.manifest.json` | Page app manifest (`buzzBudgetPerGen: 120`, scope `ai:write:budgeted`) |

## Known platform items

- **Bridge kind**: shipping seamless mode embedded on civitai.com requires the
  block bridge (`blocks.submitWorkflow`) to accept a server-owned `pano360`
  kind whose translation is `buildSeamlessTemplate` in `src/panorama.ts`.
- **Bridge run enrichment**: the flat `WORKFLOW_STATUS` snapshot carries no
  progress/queue/usage — the rich run UX embedded on civitai.com needs the
  host to attach the kit's `RunDetail` beside the snapshot (the dev orch-host
  shows exactly how; a CORS-safe `traceUrl` is the host's responsibility).
  Without it the kit degrades to elapsed time + an indeterminate bar; cancel
  still works (the real hosts implement `CANCEL_WORKFLOW` today).
- **Layer-AIR freshness**: the install layer is image-specific. The app submits
  2-step (`comfyNodepackSnapshot` + `$ref`) whenever it has no cached layer and
  invalidates + retries on a stale one. Note the orchestrator's resource grain
  negative-caches an unresolved layer for ~5 minutes — a brand-new capture (or
  the first run after the grain deactivates) can be instantly "canceled" with
  nothing billed; the UI surfaces this as a "stopped before it started — try
  again" note, and a retry lands.
