/**
 * Self-contained build for git installs (`dsh plugin add github:...` fetches
 * sources and runs this via `prepare`, without the monorepo context tsc
 * type-checking needs). Emits both faces as bundles with every @deepseek-ai
 * specifier external — they resolve from the dsh installation at runtime.
 * Local development uses `pnpm build` (tsc + tsdown) instead, which also
 * emits type declarations.
 */
import { defineConfig } from 'tsdown'
import clientConfig from './tsdown.config.ts'

export default defineConfig([{
  name: 'dsh-subscription-hub',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}, clientConfig])
