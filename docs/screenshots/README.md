# Design-system migration — before/after

Captured against the mock dev harness (`npm run dev:harness`) via headless
Chromium, in both themes and at narrow (~420px) and wide (~1180px) viewports.

| | Light | Dark |
|---|---|---|
| **Before** (wide) | `before-light-wide.png` | `before-dark-wide.png` |
| **Before** (narrow) | `before-light-narrow.png` | `before-dark-narrow.png` |
| **After** (wide) | `after-light-wide.png` | `after-dark-wide.png` |
| **After** (narrow) | `after-light-narrow.png` | `after-dark-narrow.png` |
| **After — generate flow** (success alert · disabled state · viewer loading · themed run-id) | `after-flow-light.png` | `after-flow-dark.png` |

The top banner ("MOCK HOST · no real Buzz spent") is dev-harness chrome and is
not part of the shipped block.
