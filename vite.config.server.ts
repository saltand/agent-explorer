import { builtinModules } from 'node:module'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Copies the client build next to the CLI bundle so a published package ships
 * one self-contained directory.
 */
function bundleClientAssets(): Plugin {
  return {
    name: 'bundle-client-assets',
    closeBundle() {
      const from = resolve(import.meta.dirname, 'dist')
      const to = resolve(import.meta.dirname, 'dist-server', 'client')
      if (!existsSync(resolve(from, 'index.html'))) {
        this.warn('dist/index.html not found; run the client build first')
        return
      }
      rmSync(to, { recursive: true, force: true })
      cpSync(from, to, { recursive: true })
    },
  }
}

/**
 * Bundles the CLI into a single ESM file with no runtime dependencies, so
 * `npx agent-explorer` never triggers a native build step.
 */
export default defineConfig({
  plugins: [bundleClientAssets()],
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist-server',
    emptyOutDir: true,
    minify: false,
    // The client build owns public assets; this bundle is code only.
    copyPublicDir: false,
    rollupOptions: {
      input: { main: 'server/main.ts' },
      external: [...builtinModules, /^node:/],
      // The entry's only job is a side-effecting call, so it must not be shaken.
      treeshake: { moduleSideEffects: true },
      output: {
        format: 'esm',
        entryFileNames: '[name].js',
        banner: '#!/usr/bin/env node',
      },
    },
  },
})
