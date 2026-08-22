import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = resolve(import.meta.dirname, '..')
const artifacts = new WorkspaceTypertGenerator(root).generate(['forgeyard'], ['host'])
if (artifacts.length !== 1 || artifacts[0]?.face !== 'host' || artifacts[0]?.remote === undefined) {
  throw new Error('Forgeyard Typert generation did not produce one Host artifact and one Remote client')
}
for (const artifact of artifacts) {
  const output = resolve(root, artifact.packageRoot, 'lib')
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(output, `typert.${artifact.face}.js`), artifact.js)
  writeFileSync(resolve(output, `typert.${artifact.face}.d.ts`), artifact.dts)
  if (artifact.remote !== undefined) {
    writeFileSync(resolve(output, 'typert.remote-client.js'), artifact.remote.js)
    writeFileSync(resolve(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
    writeFileSync(resolve(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
  }
}
