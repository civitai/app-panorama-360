# @civitai/comfy-run-kit

A first-class, reusable **customComfy run experience** for apps built on the
Civitai orchestrator: live progress (queue position → model-download % → real
sampler steps), a live Buzz cost meter, live previews and worker logs, and a
real cancel button — as a framework-free headless core plus drop-in custom
elements. Everything comfy.civitai.com shows, reconstructed **pull-only** from
the consumer API (no websocket relay, no server middleman).

Incubating as a workspace package inside `civitai-panorama-360` (its first
consumer); designed for extraction — the lib build + `publishConfig` are
already wired.

## What it renders

```html
<civitai-comfy-run></civitai-comfy-run>  <!-- composite of the four below -->

<civitai-run-status>   phase label · unified progress bar · queue "N ahead" ·
                       current node · elapsed · Cancel button
<civitai-buzz-meter>   live ⚡ "~N Buzz so far · 1 Buzz/s" → settled total +
                       per-wallet transactions
<civitai-run-preview>  the sampler's live preview image (when the worker emits previews)
<civitai-run-logs>     collapsible worker console tail ("Show logs (N)")
```

Shadow DOM, themed via `--crk-*` custom properties (they inherit through
shadow boundaries — one CSS rule on the host page themes everything). The
cancel button emits a composed `civitai-run-cancel` event.

## Architecture

```
RunGateway (submit / poll / cancel)          → where workflow calls go
 ├─ DirectGateway   consumer API (fetch), baseUrl injectable (point it at a
 │                  token-injecting same-origin proxy)
 └─ BridgeGateway   block postMessage (SUBMIT/POLL/CANCEL_WORKFLOW) — reads the
                    optional `detail: RunDetail` enrichment beside the snapshot

RunController                                → the state machine
 poll loop (adaptive: long-poll aware) + trace tail + 250ms buzz ticker
 → one RunState stream the elements render

TraceTailer + TraceFrameDecoder             → the real-time channel
 streams the `trace: "binary"` blob (the worker's recorded ComfyUI /ws session)
```

### The signals, and where they come from

| Signal | Source |
|---|---|
| queue position + ETA | `steps[].jobs[].queuePosition {precedingJobs, startAt}` on every poll |
| model-download % | `steps[].jobs[].estimatedProgressRate` while the job status is `Preparing` |
| real sampler steps, per-node execution, previews, logs, tracebacks | the trace blob (`steps[].output.traceUrl`, submit with `input.trace: "binary"`) |
| live Buzz cost | `steps[].output.usage {buzzPerSecond, estimatedCost, runtimeSeconds, startedAt}` + local extrapolation |
| cancel | `PUT /v2/consumer/workflows/{id} {"status":"canceled"}` — a REAL mid-render ComfyUI interrupt (workers v12+); post-paid billing charges only elapsed runtime |

### Trace blob wire format

Repeating frames: `[timestamp: 8B BE epoch-ms][direction: 1B][opcode: 1B][length: 4B BE][payload]`.
Opcode 1 = UTF-8 JSON ComfyUI ws frame `{type, data}`; opcode 2 = preview image
bytes (ComfyUI's 8-byte preview header stripped at record time — sniff the magic).
Hard-won semantics (from the comfy-nodes offload tailer, re-verified here):

- the blob **404s until the worker writes its first byte** — retry 0.5s → 5s;
- a **clean stream end means complete — never reconnect** (a fresh GET replays
  from byte 0 and double-emits); an abnormal break reconnects and byte-skips;
- frames split across chunks — the decoder carries the partial;
- the worker flushes in batches, so events arrive **bursty** (seconds apart);
- keep tailing ~10s after the workflow goes terminal for the tail frames.

### Buzz meter semantics (the sawtooth lesson)

Post-paid customComfy bills `1 Buzz × runtime second`, and the runtime clock
starts at ComfyUI **execution start — not at submit, not during model
downloads**. Mid-run, `usage.startedAt` is *derived* (`computedAt −
runtimeSeconds`) from heartbeat-lagged runtime, so trusting the freshest sample
re-anchors the meter to "started ~1s ago" every poll and saw-tooths the
counter. The meter therefore anchors on the **earliest** billing-start evidence
ever seen (the trace's first execution frame lands within ~100ms of the true
start), never moves the anchor forward, shows a flat honest `0` before compute
begins, and snaps to the settled `cost.total` at terminal.

### `RunDetail` — the bridge enrichment seam

The block bridge's `WORKFLOW_STATUS` snapshot is deliberately flat (no
progress/queue/usage fields). A host with orchestrator access attaches a
`detail: RunDetail` field beside the snapshot (extra payload fields survive the
postMessage clone) — `mapDocToDetail(doc)` builds it from the workflow doc.
The panorama dev harness's orch-host does this today; it is exactly the shape a
future platform-bridge enrichment would own. **No `detail` degrades
gracefully**: elapsed time + indeterminate bar, cancel still real
(`CANCEL_WORKFLOW` is in the published SDK and implemented by the real
civitai.com hosts and the mock host).

## Usage

```ts
import { RunController, DirectGateway } from '@civitai/comfy-run-kit';
import { BridgeGateway } from '@civitai/comfy-run-kit/bridge';
import { registerRunElements } from '@civitai/comfy-run-kit/elements';

registerRunElements();

const controller = new RunController({
  gateway: new BridgeGateway(),        // or new DirectGateway({ baseUrl: '/orch' })
  nodeLabels: { '7': 'Sampling' },     // optional friendly names for `executing` node ids
});

document.querySelector('civitai-comfy-run')!.controller = controller;
document.addEventListener('civitai-run-cancel', () => void controller.cancel());
await controller.start(workflowBody);
```

Theme bridge (host page CSS):

```css
civitai-comfy-run { --crk-surface: …; --crk-border: …; --crk-text: …;
  --crk-muted: …; --crk-accent: …; --crk-danger: …; --crk-code-bg: …; }
```

## Tests

`vitest` — decoder (split-at-every-byte, preview frames), tailer (404 ladder,
clean-EOF no-reconnect, byte-skip replay), buzz meter (anchor precedence,
sawtooth regression), derive (phase ladder, degradation), run controller
(cancel semantics incl. out-of-buzz vs user labeling), gateways, and jsdom
element tests. Run from the repo root: `npm test` (projects `kit-node` /
`kit-dom`).
