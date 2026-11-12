/**
 * Build script for dsh-plugin-guard: host -> lib/index.js.
 *
 * This plugin is HOST-ONLY (no client bundle, no settings page): mounting it
 * registers one global system-prompt section that injects the plugin-authoring
 * conventions into every agent.
 *
 * Usage: `node scripts/build.mjs`
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = resolve(root, 'lib')
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(outdir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*', 'node:*'],
  logLevel: 'info',
})

console.log('host  -> lib/index.js')