// jsdom setup for the `dom` vitest project (*.dom.test.ts).
//
// Photo Sphere Viewer needs WebGL + real layout, neither of which jsdom has —
// component tests mock '@photo-sphere-viewer/core' per-suite via vi.mock.

// jsdom has no ResizeObserver; <pano-app> uses it for RESIZE_IFRAME reports.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

export {};
