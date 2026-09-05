import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const storage = new Map()
globalThis.localStorage = {
  getItem(key) { return storage.get(key) ?? null },
  setItem(key, value) { storage.set(key, String(value)) },
  removeItem(key) { storage.delete(key) },
  clear() { storage.clear() }
}
globalThis.window = {
  location: {
    protocol: 'https:',
    hostname: 'gateway.example',
    port: '',
    href: 'https://gateway.example/agents/',
    reload() {}
  },
  HARNESS_REMOTE_GATEWAY_MODE: true,
  HARNESS_REMOTE_PROVISIONED_MACHINES: [
    { id: 'arch-desktop', name: 'Arch desktop', proxyPath: '/api/harness/arch-desktop' },
    { id: 'arch-desktop', name: 'Ignored duplicate', proxyPath: '/api/harness/duplicate' },
    { id: 'absolute-url', name: 'Unsafe', proxyPath: 'https://evil.example/harness' },
    { id: 'protocol-relative', name: 'Unsafe', proxyPath: '//evil.example/harness' }
  ]
}

const {
  WORKSPACE_MACHINES_STORAGE_KEY,
  isGatewayDeployment,
  loadWorkspaceMachines,
  persistWorkspaceMachines
} = await import('./workspaceMachines.ts')
const { disableGatewayServiceWorker } = await import('./serviceWorker.ts')

assert.equal(isGatewayDeployment(), true)

storage.set(WORKSPACE_MACHINES_STORAGE_KEY, JSON.stringify([
  {
    id: 'arch-desktop',
    name: 'Browser override',
    config: {
      backend: 'opencode',
      host: 'evil.example',
      port: 4097,
      username: 'attacker',
      password: 'stored-secret',
      proxyPath: '/wrong'
    }
  },
  {
    id: 'laptop',
    name: 'Laptop',
    config: {
      backend: 'opencode',
      host: 'laptop.local',
      port: 4097,
      username: 'harness',
      password: 'local-secret',
      proxyPath: '/saved-proxy'
    }
  }
]))

const loaded = loadWorkspaceMachines()
assert.deepEqual(loaded.map((machine) => machine.id), ['arch-desktop', 'laptop'])
assert.deepEqual(loaded[0], {
  id: 'arch-desktop',
  name: 'Arch desktop',
  config: {
    backend: 'opencode',
    host: 'https://gateway.example',
    port: 443,
    username: '',
    password: '',
    proxyPath: '/api/harness/arch-desktop',
    agentId: undefined
  },
  provisioned: true
})
assert.equal(loaded[1].config.proxyPath, '/saved-proxy', 'saved proxy paths must survive normalization')

persistWorkspaceMachines(loaded)
const persisted = JSON.parse(storage.get(WORKSPACE_MACHINES_STORAGE_KEY))
assert.deepEqual(persisted.map((machine) => machine.id), ['laptop'])
assert.equal(persisted[0].config.proxyPath, '/saved-proxy')
assert.equal(JSON.stringify(persisted).includes('stored-secret'), false)

persistWorkspaceMachines(loaded.filter((machine) => !machine.provisioned))
assert.equal(loadWorkspaceMachines()[0].id, 'arch-desktop', 'local deletion cannot remove a gateway-provisioned machine')

persistWorkspaceMachines([{
  ...loaded[0],
  provisioned: false,
  name: 'Attempted override',
  config: { ...loaded[0].config, proxyPath: '/attempted-override' }
}])
assert.deepEqual(JSON.parse(storage.get(WORKSPACE_MACHINES_STORAGE_KEY)), [], 'a provisioned id must never enter local persistence')
assert.equal(loadWorkspaceMachines()[0].config.proxyPath, '/api/harness/arch-desktop')

const manager = readFileSync(new URL('./components/standalone-universal-workspace.tsx', import.meta.url), 'utf8')
assert.match(manager, /machine\.provisioned \? \(/, 'gateway-provisioned machines must render a managed state')
assert.match(manager, /if \(machine\.provisioned\) return/, 'edit and delete handlers must reject provisioned machines')

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
assert.ok(index.indexOf('%BASE_URL%config.js') < index.indexOf('/src/main.tsx'), 'gateway config must load before the application entry')
const defaultConfig = readFileSync(new URL('../public/config.js', import.meta.url), 'utf8')
assert.match(defaultConfig, /HARNESS_REMOTE_GATEWAY_MODE = false/)
assert.match(defaultConfig, /HARNESS_REMOTE_PROVISIONED_MACHINES = \[\]/)
assert.match(readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8'), /HARNESS_REMOTE_BASE_PATH/)

let reloads = 0
window.location.reload = () => { reloads += 1 }
const sessionValues = new Map()
globalThis.sessionStorage = {
  getItem(key) { return sessionValues.get(key) ?? null },
  setItem(key, value) { sessionValues.set(key, String(value)) },
  removeItem(key) { sessionValues.delete(key) }
}
let unregisters = 0
let unrelatedUnregisters = 0
let registrations = [{
  scope: 'https://gateway.example/agents/',
  active: { scriptURL: 'https://gateway.example/agents/sw.js' },
  unregister: async () => { unregisters += 1; return true }
}, {
  scope: 'https://gateway.example/',
  active: { scriptURL: 'https://gateway.example/sw.js' },
  unregister: async () => { unrelatedUnregisters += 1; return true }
}]
const serviceWorker = {
  controller: { scriptURL: 'https://gateway.example/agents/sw.js' },
  async getRegistrations() { return registrations }
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker } })
const deletedCaches = []
globalThis.caches = {
  async keys() { return ['harness-remote-v3', 'unrelated-cache'] },
  async delete(key) { deletedCaches.push(key); return true }
}
window.caches = globalThis.caches

assert.equal(await disableGatewayServiceWorker('/agents/'), 'reloading')
assert.equal(unregisters, 1, 'only the exact gateway base registration should be removed')
assert.equal(unrelatedUnregisters, 0, 'a worker registered for another base must remain untouched')
assert.deepEqual(deletedCaches, ['harness-remote-v3'], 'legacy app caches must be cleared before reload')
assert.equal(reloads, 1, 'a page controlled by the legacy worker must reload before rendering')

registrations = []
serviceWorker.controller = undefined
assert.equal(await disableGatewayServiceWorker('/agents/'), 'ready', 'the reloaded gateway page may render only without the legacy controller')

const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
assert.match(main, /isGatewayDeployment\(\).*disableGatewayServiceWorker/s)
assert.match(main, /if \(result === "ready"\).*renderApp\(\)/s)
assert.doesNotMatch(main, /isGatewayDeployment\(\)[\s\S]*serviceWorker\.register/)

console.log('workspace machine bootstrap tests passed')
