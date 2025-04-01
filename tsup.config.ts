import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'dist/index': 'src/index.ts',
    utils: 'src/utils.ts',
  },
  outDir: './',
  splitting: true,
  format: ['esm', 'cjs'],
  minify: true,
  target: 'es2015',
  dts: true,
});
