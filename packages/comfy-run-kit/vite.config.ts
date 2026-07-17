import { defineConfig } from 'vite';

// Lib build exists only for eventual publish/extraction — day-to-day consumers
// (the panorama app, vitest, tsc) import the TS source via the package
// `exports`. `publishConfig.exports` flips to dist/ at publish time.
export default defineConfig({
  build: {
    target: 'es2022',
    lib: {
      entry: {
        index: 'src/index.ts',
        'bridge-gateway': 'src/bridge-gateway.ts',
        elements: 'src/elements.ts',
      },
      formats: ['es'],
    },
    rollupOptions: { external: [/^@civitai\//] },
  },
});
