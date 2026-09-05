import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { streamURL } from './opencode-events.ts'
import {
  agentScopedPath,
  appendServerPath,
  authHeader,
  baseUrl,
  hasCredentials,
  isValidServerConfig,
  machineBaseUrl,
  normalizeProxyPath,
  normalizeServerConfig,
  normalizeServerHost
} from './serverConfig.ts'

const config = (host, port = 4096) => ({ backend: 'opencode', host, port, username: 'opencode', password: 'secret' })

for (const host of ['http:', 'http://', 'https:', 'https://', '', '   ']) {
  assert.equal(isValidServerConfig(config(host)), false, `half-typed host ${JSON.stringify(host)} must be rejected`)
}
for (const host of ['Giulio-S7', 'localhost', '192.168.1.64', 'http://192.168.1.64', 'https://example.com', 'http://192', 'HTTP://LOCALHOST/']) {
  assert.equal(isValidServerConfig(config(host)), true, `usable host ${JSON.stringify(host)} must be accepted`)
}
assert.equal(isValidServerConfig(config('localhost', 0)), false)
assert.equal(isValidServerConfig(config('localhost', 70000)), false)
assert.equal(isValidServerConfig(config('localhost', Number.NaN)), false)
assert.equal(isValidServerConfig(config('example.com/path')), false)
assert.equal(isValidServerConfig(config('example.com:4097')), false)
assert.equal(normalizeServerHost(' LOCALHOST '), 'localhost')
assert.equal(normalizeServerHost('HTTP://LOCALHOST/'), 'http://localhost')
assert.equal(normalizeServerHost('192.168.1.64'), '192.168.1.64')
assert.equal(baseUrl(config('192.168.1.64')), 'http://192.168.1.64:4096')
assert.equal(baseUrl(config('https://example.com')), 'https://example.com:4096')

for (const path of ['/api/harness/arch-desktop', '/gateway', '/']) {
  assert.equal(normalizeProxyPath(path), path)
  assert.equal(isValidServerConfig({ ...config('https://gateway.example', 443), proxyPath: path }), true)
}
for (const path of [
  'api/harness',
  '//evil.example/harness',
  'https://evil.example/harness',
  '/api/harness/',
  '/api//harness',
  '/api/./harness',
  '/api/../harness',
  '/api/%2e%2e/harness',
  '/api/%2f../harness',
  '/api/%2e%2e%2fharness',
  '/api/%252e%252e%252fharness',
  '/api/%5c../harness',
  '/api\\harness',
  '/api/harness?machine=desktop',
  '/api/harness#desktop',
  '/api/\nharness'
]) {
  assert.equal(normalizeProxyPath(path), null, `unsafe proxy path ${JSON.stringify(path)} must be rejected`)
  assert.equal(isValidServerConfig({ ...config('https://gateway.example', 443), proxyPath: path }), false)
}
assert.equal(normalizeProxyPath(undefined), undefined)
assert.equal(normalizeServerConfig({ ...config('HTTPS://GATEWAY.EXAMPLE', 443), proxyPath: '/api/harness/arch-desktop' })?.proxyPath, '/api/harness/arch-desktop')

const daemon = { ...config('192.168.1.64', 4097), backend: 'codex', agentId: 'opencode' }
assert.equal(machineBaseUrl(daemon), 'http://192.168.1.64:4097')
assert.equal(baseUrl(daemon), 'http://192.168.1.64:4097/v1/agents/opencode')
assert.equal(agentScopedPath(daemon, '/session'), '/v1/agents/opencode/session')
assert.equal(agentScopedPath({ ...daemon, agentId: undefined }, '/session'), '/session')
assert.equal(streamURL(baseUrl(daemon), 'global'), 'http://192.168.1.64:4097/v1/agents/opencode/global/event')
assert.equal(baseUrl({ ...daemon, agentId: 'claude/code' }), 'http://192.168.1.64:4097/v1/agents/claude%2Fcode')
const proxiedDaemon = { ...daemon, host: 'https://gateway.example', port: 443, proxyPath: '/api/harness/arch-desktop' }
assert.equal(machineBaseUrl(proxiedDaemon), 'https://gateway.example:443/api/harness/arch-desktop')
assert.equal(baseUrl(proxiedDaemon), 'https://gateway.example:443/api/harness/arch-desktop/v1/agents/opencode')
assert.equal(appendServerPath(machineBaseUrl(proxiedDaemon), '/v1/machine'), 'https://gateway.example:443/api/harness/arch-desktop/v1/machine')
assert.equal(appendServerPath(baseUrl(proxiedDaemon), '/session?directory=%2Fwork'), 'https://gateway.example:443/api/harness/arch-desktop/v1/agents/opencode/session?directory=%2Fwork')
assert.equal(streamURL(baseUrl(proxiedDaemon), 'global'), 'https://gateway.example/api/harness/arch-desktop/v1/agents/opencode/global/event')
assert.equal(streamURL(baseUrl(proxiedDaemon), 'project', '/work/tree'), 'https://gateway.example/api/harness/arch-desktop/v1/agents/opencode/event?directory=%2Fwork%2Ftree')
assert.equal(machineBaseUrl({ ...proxiedDaemon, proxyPath: '/' }), 'https://gateway.example:443')

for (const relativePath of [
  './api.ts',
  './machineClient.ts',
  './taskClient.ts',
  './native-session-claim.ts',
  './native-session-handoff.ts',
  './native-session-prompt.ts',
  './native-session-stop.ts',
  './opencode-events.ts',
  '../electron/request-transport.ts',
  '../electron/event-transport.ts'
]) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  assert.match(source, /appendServerPath/, `${relativePath} must preserve proxy paths while building URLs`)
  assert.doesNotMatch(source, /new URL\(\s*["'`]\/(?:global\/event|event)/, `${relativePath} must not reset the gateway prefix`)
}

const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
const standalone = readFileSync(new URL('./components/standalone-universal-workspace.tsx', import.meta.url), 'utf8')
assert.match(main, /<ErrorBoundary resetKeys=\{SERVER_STORAGE_KEYS\}>/)
assert.match(main, /loadWorkspaceMachines/)
assert.match(main, /<StandaloneUniversalWorkspace/)
assert.doesNotMatch(main, /loadServerProfiles/)
assert.match(standalone, /discoverMachine\(nextMachine\(\)\.config\)/)
assert.match(standalone, /Number\(port\) >= 1 && Number\(port\) <= 65_535/)

const boundary = readFileSync(new URL('./ErrorBoundary.tsx', import.meta.url), 'utf8')
assert.match(boundary, /localStorage\.removeItem\(key\)/)

const creds = (username, password) => ({ backend: 'opencode', host: 'localhost', port: 4096, username, password })
assert.equal(authHeader(creds('opencode', 'secret')), 'Basic b3BlbmNvZGU6c2VjcmV0')
assert.equal(authHeader(creds(' opencode ', ' secret ')), authHeader(creds('opencode', 'secret')))
assert.equal(authHeader(creds('opencode', 'pàssword')), 'Basic b3BlbmNvZGU6cMOgc3N3b3Jk')
assert.doesNotThrow(() => authHeader(creds('opencode', 'påsswörd☂')))
assert.equal(hasCredentials(creds('', '')), false)
assert.equal(hasCredentials(creds('opencode', '')), false)
assert.equal(hasCredentials(creds('', 'secret')), false)
assert.equal(hasCredentials(creds('opencode', 'secret')), true)

console.log('server config regression tests passed')
