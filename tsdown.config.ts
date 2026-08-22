import { resolve } from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'

const root = import.meta.dirname
const packageRoot = resolve(root, 'packages/forgeyard')
const face = process.env.FORGEYARD_BUILD_FACE

const host: UserConfig = {
  name: 'forgeyard',
  entry: { index: resolve(packageRoot, 'lib/types/index.js') },
  outDir: resolve(packageRoot, 'lib'),
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, 'zod'],
  },
}

const clientExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
]

const client: UserConfig = {
  name: 'forgeyard/client',
  entry: { client: resolve(packageRoot, 'lib/types/client/index.js') },
  outDir: resolve(packageRoot, 'lib'),
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  minify: false,
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: clientExternals,
    alwaysBundle: (id: string) => clientExternals.includes(id) ? undefined : true,
    onlyBundle: ['zod'],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  plugins: [
    {
      name: 'forgeyard-remote',
      resolveId(source: string) {
        if (source !== 'forgeyard/remote') return null
        return resolve(packageRoot, 'lib/typert.remote-client.js')
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "forgeyard", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

if (face !== 'host' && face !== 'client') {
  throw new Error('FORGEYARD_BUILD_FACE must be host or client')
}

export default defineConfig(face === 'host' ? host : client)
