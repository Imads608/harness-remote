import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const storage = new Map()
globalThis.localStorage = {
  getItem(key) { return storage.get(key) ?? null },
  setItem(key, value) { storage.set(key, String(value)) },
  removeItem(key) { storage.delete(key) },
  clear() { storage.clear() }
}

const {
  ACTIVE_PROFILE_STORAGE_KEY,
  SERVER_PROFILES_STORAGE_KEY,
  createServerProfile,
  loadActiveServerProfile,
  loadServerProfiles,
  persistServerProfiles
} = await import('./serverProfiles.ts')

storage.set('opencode.remote.server.opencode', JSON.stringify({ backend: 'opencode', host: 'desktop.local', port: 4096, username: 'opencode', password: '' }))
storage.set('opencode.remote.server.omp', JSON.stringify({ backend: 'omp', host: 'pi.local', port: 4097, username: 'omp', password: 'secret' }))

const migrated = loadServerProfiles()
assert.equal(migrated.length, 2, 'each legacy backend configuration should migrate to its own saved server')
assert.deepEqual(migrated.map((profile) => profile.config.backend), ['opencode', 'omp'])

const added = createServerProfile('Work PI', 'pi')
const copilot = createServerProfile('Desktop Copilot', 'copilot')
const profiles = [...migrated, added, copilot]
persistServerProfiles(profiles, copilot.id)
assert.equal(JSON.parse(storage.get(SERVER_PROFILES_STORAGE_KEY)).length, 4, 'saved profiles should persist as one collection')
assert.equal(storage.get(ACTIVE_PROFILE_STORAGE_KEY), copilot.id, 'the selected server should persist independently')
assert.equal(loadActiveServerProfile(loadServerProfiles()).name, 'Desktop Copilot', 'the saved selection should be restored at launch')
assert.equal(loadActiveServerProfile(loadServerProfiles()).config.backend, 'copilot', 'Copilot must survive profile persistence')

// An upgrade can have a new collection created before all older backend-specific keys are migrated.
// Loading must retain that OMP entry instead of letting a reload overwrite its only representation.
storage.clear()
const collectionProfile = {
  id: 'collection-opencode',
  name: 'Current OpenCode',
  config: { backend: 'opencode', host: 'desktop.local', port: 4096, username: 'opencode', password: '' }
}
storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify([collectionProfile]))
storage.set('opencode.remote.server.omp', JSON.stringify({ backend: 'omp', host: 'pi.local', port: 4097, username: 'omp', password: 'secret' }))
const mergedMigration = loadServerProfiles()
assert.deepEqual(mergedMigration.map((profile) => profile.config.backend), ['opencode', 'omp'], 'a legacy OMP profile must survive alongside the saved profile collection')

const daemonProfile = {
  id: 'machine-profile',
  name: 'Workstation',
  config: { backend: 'opencode', host: 'workstation.local', port: 4097, username: 'harness', password: 'secret', agentId: 'opencode' }
}
persistServerProfiles([daemonProfile], daemonProfile.id)
const restoredDaemon = loadActiveServerProfile(loadServerProfiles())
assert.equal(restoredDaemon.config.agentId, 'opencode', 'machine agent selection should survive restart')

const gatewayProfile = {
  id: 'gateway-profile',
  name: 'Gateway machine',
  config: {
    backend: 'opencode',
    host: 'https://gateway.example',
    port: 443,
    username: '',
    password: '',
    proxyPath: '/api/harness/arch-desktop'
  }
}
storage.set(ACTIVE_PROFILE_STORAGE_KEY, gatewayProfile.id)
persistServerProfiles([gatewayProfile], gatewayProfile.id)
assert.equal(loadServerProfiles()[0].config.proxyPath, '/api/harness/arch-desktop', 'gateway proxy paths should survive profile persistence')

const invalidGatewayProfile = structuredClone(gatewayProfile)
invalidGatewayProfile.config.proxyPath = 'https://evil.example/harness'
storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify([invalidGatewayProfile]))
assert.notEqual(loadServerProfiles()[0].id, invalidGatewayProfile.id, 'absolute proxy URLs must be rejected from saved profiles')

storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify([gatewayProfile]))
const malformed = JSON.parse(storage.get(SERVER_PROFILES_STORAGE_KEY))
malformed[0].config.agentId = { invalid: true }
storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify(malformed))
assert.equal(loadServerProfiles()[0].config.agentId, undefined, 'malformed agent ids must not leak from persisted data')

storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify([{
  id: 'old-pi-wizard-profile',
  name: 'PI test machine',
  config: { backend: 'codex', host: 'workstation.local', port: 4097, username: 'harness', password: 'secret', agentId: 'codex' }
}]))
const repaired = loadServerProfiles()[0]
assert.equal(repaired.config.backend, 'pi', 'an unmistakably named PI profile saved by the old fallback must recover PI')
assert.equal(repaired.config.agentId, 'pi', 'the repaired PI profile must target the PI daemon route')

storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify([{
  id: 'old-copilot-wizard-profile',
  name: 'GitHub Copilot CLI server',
  config: { backend: 'codex', host: 'workstation.local', port: 4097, username: 'harness', password: 'secret', agentId: 'codex' }
}]))
const repairedCopilot = loadServerProfiles()[0]
assert.equal(repairedCopilot.config.backend, 'copilot', 'an unmistakably named Copilot profile saved by the old fallback must recover Copilot')
assert.equal(repairedCopilot.config.agentId, 'copilot', 'the repaired Copilot profile must target the Copilot daemon route')

storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify([
  { id: 'known-daemon-profile', name: 'Codex CLI server', config: { backend: 'codex', host: 'localhost', port: 5001, username: 'harness', password: 'secret', agentId: 'codex' } },
  { id: 'old-omp-internal-port-profile', name: 'Oh My Pi TEST', config: { backend: 'omp', host: 'localhost', port: 4096, username: 'harness', password: 'secret' } }
]))
const repairedPort = loadServerProfiles().find((profile) => profile.id === 'old-omp-internal-port-profile')
assert.ok(repairedPort, 'the OMP profile should be retained')
assert.equal(repairedPort.config.port, 5001, 'a named local OMP profile must reuse the known daemon port instead of assuming 4097')
assert.equal(repairedPort.config.agentId, 'omp', 'a repaired OMP daemon profile must use the OMP route')

storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify([{
  id: 'unknown-daemon-port-profile',
  name: 'Oh My Pi TEST',
  config: { backend: 'omp', host: 'localhost', port: 4096, username: 'harness', password: 'secret' }
}]))
const unknownPort = loadServerProfiles()[0]
assert.equal(unknownPort.config.port, 4096, 'a profile with no known machine daemon port must not be guessed')
assert.equal(unknownPort.config.agentId, undefined, 'an unknown daemon port must not fabricate an agent route')

const storageKeys = readFileSync(new URL('./storageKeys.ts', import.meta.url), 'utf8')
assert.match(storageKeys, /SERVER_PROFILES_STORAGE_KEY/, 'the crash-recovery reset must clear saved servers')
assert.match(storageKeys, /ACTIVE_PROFILE_STORAGE_KEY/, 'the crash-recovery reset must clear the selected server')
assert.ok(!/"opencode\.remote\.(serverProfiles|activeServerProfile)"/.test(storageKeys), 'storage keys must have a single definition')

const desktopBridge = readFileSync(new URL('./desktopBridge.ts', import.meta.url), 'utf8')
const desktopRegistry = readFileSync(new URL('../electron/profile-registry.ts', import.meta.url), 'utf8')
assert.match(desktopBridge, /left\.proxyPath === right\.proxyPath/, 'renderer profile equality must separate gateway paths')
assert.match(desktopBridge, /proxyPath: normalized\.proxyPath/, 'desktop profile synchronization must preserve gateway paths')
assert.match(desktopRegistry, /left\.proxyPath === right\.proxyPath/, 'Electron profile equality must separate gateway paths')
assert.match(desktopRegistry, /normalizeProxyPath\(candidate\.proxyPath\)/, 'Electron must validate persisted gateway paths')

console.log('server profile tests passed')
