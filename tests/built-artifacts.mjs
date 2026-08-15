import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const host = await import('../lib/index.js')
assert.equal(host.name, 'image-gen')
assert.equal(typeof host.apply, 'function')
assert.deepEqual(host.inject, ['tools', 'attachments', 'credentials', 'connection', 'sessionPersistence'])

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

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(manifest.dsh.client.platform, 'web')
assert.equal(manifest.exports['./client'].default, './lib/client.js')

console.log('built artifact smoke passed')
