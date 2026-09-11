import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import semver from 'semver'
import vm from 'node:vm'

const host = await import('../lib/index.js')
assert.equal(host.name, 'image-gen')
assert.equal(typeof host.apply, 'function')
assert.deepEqual(host.inject, ['tools', 'attachments', 'credentials', 'connection', 'webServer', 'sessionPersistence'])

let descriptor
const windowValue = {
  __ModuleLoader__: {
    load(value) { descriptor = value },
  },
}
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInNewContext(source, { window: windowValue, console }, { filename: 'lib/client.js' })
assert.equal(descriptor?.id, 'dsh-image-gen')
assert.equal(typeof descriptor?.factory, 'function')
const require = createRequire(import.meta.url)
const client = descriptor.factory(require)
assert.equal(typeof client.apply, 'function')
assert.deepEqual([...client.inject], ['slots', 'locale', 'connection'])
assert.match(source, /unverified/)

const sourceMap = JSON.parse(await readFile(new URL('../lib/client.js.map', import.meta.url), 'utf8'))
const clientSourceIndex = sourceMap.sources.findIndex(value => value.endsWith('../src/client/index.tsx'))
assert.notEqual(clientSourceIndex, -1)
const currentClientSource = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
assert.equal(
  sourceMap.sourcesContent[clientSourceIndex].replace(/\r\n?/g, '\n'),
  currentClientSource.replace(/\r\n?/g, '\n'),
)

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(manifest.version, '0.4.1')
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(manifest.dsh.client.platform, 'web')
assert.deepEqual(manifest.dsh.client.inject, [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-tool',
])
assert.deepEqual(manifest.dsh.compatibility, {
  dsh: '>=0.1.2-rc.1 <0.1.3-0',
  dshReleases: {
    '0.1.2-alpha.3': 'unknown',
    '0.1.2-alpha.4': 'unknown',
    '0.1.2-alpha.5': 'unknown',
    '0.1.2-rc.1': 'compatible',
  },
  profiles: ['web'],
})
assert.equal(semver.satisfies('0.1.2-rc.1', manifest.dsh.compatibility.dsh), true)
assert.equal(semver.satisfies('0.1.2-alpha.5', manifest.dsh.compatibility.dsh), false)
assert.equal('dsh-client-runtime' in manifest.peerDependencies, false)
assert.equal(manifest.exports['./client'].default, './lib/client.js')

// A loader entry, not the module's exported `inject` array, owns the runtime
// capability boundary. The plugin opens a loopback RPC route through
// `connection.rpc.handle()`, which reaches `webServer.register()` on the
// connection service's own context, so the patch must grant `webServer` to the
// connection entry as well as to this plugin's own entry.
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
for (const service of ['tools', 'attachments', 'credentials', 'connection', 'webServer', 'sessionPersistence']) {
  assert.match(patch, new RegExp(`\\b${service}\\b`), `cordis.patch.yml must grant ${service}`)
}
assert.match(
  patch,
  /- id: connection\s*\n\s*inject:\s*\[[^\]]*\bwebServer\b[^\]]*\]/u,
  'cordis.patch.yml must grant webServer to the connection loader entry',
)

console.log('built artifact smoke passed')
