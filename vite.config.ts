import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../out/renderer',
    emptyOutDir: true,
    target: 'chrome128',
  },
  server: { port: 5173, strictPort: true },
});
