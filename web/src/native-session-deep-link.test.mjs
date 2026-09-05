import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  consumeNativeSessionDeepLink,
  createNativeSessionDeepLinkNavigation,
  parseNativeSessionDeepLink,
  resolveDeepLinkMachine
} from "./native-session-deep-link.ts"

const agent = {
  id: "copilot",
  label: "GitHub Copilot CLI",
  backend: "copilot",
  transport: "acp",
  managed: true,
  state: "available",
  capabilities: { sessions: true }
}
const desktop = {
  machine: {
    id: "gateway-arch-desktop",
    name: "Arch desktop",
    provisioned: true,
    config: {
      backend: "opencode",
      host: "https://gateway.example",
      port: 443,
      username: "",
      password: "",
      proxyPath: "/api/harness/arch-desktop"
    }
  },
  snapshot: { machine: { id: "daemon-desktop", name: "Arch" }, agents: [agent] },
  state: "online"
}
const pi = {
  machine: {
    ...desktop.machine,
    id: "gateway-pi",
    name: "Pi",
    config: { ...desktop.machine.config, proxyPath: "/api/harness/pi" }
  },
  snapshot: { machine: { id: "daemon-pi", name: "Pi" }, agents: [agent] },
  state: "online"
}
const loading = (runtime) => ({ ...runtime, snapshot: null, state: "loading" })
const offline = (runtime) => ({ ...runtime, snapshot: null, state: "offline", error: "Connection timed out" })
const sessionID = "native session+id/=?"
const search = `?machine=${desktop.machine.id}&agent=copilot&session=${encodeURIComponent(sessionID)}&directory=%2Funtrusted&view=incident#ignored`
const session = { id: sessionID, title: "Incident investigation", directory: "/authoritative/repo", external: false, time: { created: 1, updated: 2 } }
const request = parseNativeSessionDeepLink(search).request
assert.equal(request.sessionID, sessionID)
assert.deepEqual(Object.keys(request).sort(), ["agentID", "machineID", "sessionID"])
assert.equal(parseNativeSessionDeepLink("?view=incident&directory=/untrusted"), null)
for (const invalid of [
  "?session=s",
  "?machine=m&agent=&session=s",
  "?machine=m&agent=copilot&session=%20",
  "?machine=m&machine=m&agent=copilot&session=s",
  "?machine=m&agent=copilot&agent=pi&session=s",
  "?machine=m&agent=copilot&session=s&session=other"
]) assert.match(parseNativeSessionDeepLink(invalid).error, /Invalid Session link/)

assert.equal(resolveDeepLinkMachine(request, [loading(desktop), pi]).state, "waiting")
assert.equal(resolveDeepLinkMachine(request, [desktop, loading(pi)]).state, "ready")
assert.equal(resolveDeepLinkMachine(request, [desktop, offline(pi)]).runtime, desktop)
assert.equal(resolveDeepLinkMachine({ ...request, machineID: pi.machine.id }, [offline(desktop), pi]).runtime, pi)
assert.equal(resolveDeepLinkMachine({ ...request, machineID: "daemon-pi" }, [loading(desktop), pi]).runtime, pi)
assert.equal(resolveDeepLinkMachine({ ...request, machineID: "daemon-pi" }, [desktop, loading(pi)]).state, "waiting")
assert.equal(resolveDeepLinkMachine({ ...request, machineID: "unknown" }, [desktop, loading(pi)]).state, "waiting")
assert.match(resolveDeepLinkMachine({ ...request, machineID: "unknown" }, [desktop, offline(pi)]).message, /not found/)
assert.match(resolveDeepLinkMachine(request, [offline(desktop), loading(pi)]).message, /unavailable.*Connection timed out/)
assert.match(resolveDeepLinkMachine({ ...request, agentID: "unknown" }, [desktop, loading(pi)]).message, /agent "unknown" was not found/)
assert.equal(resolveDeepLinkMachine({ ...request, agentID: "unknown" }, [loading(desktop), pi]).state, "waiting")
assert.match(resolveDeepLinkMachine(request, [{ ...desktop, snapshot: { ...desktop.snapshot, agents: [{ ...agent, capabilities: { sessions: false } }] } }]).message, /does not support/)
assert.match(resolveDeepLinkMachine({ ...request, machineID: "daemon-desktop" }, [desktop, { ...pi, snapshot: desktop.snapshot }]).message, /ambiguous/)
assert.equal(resolveDeepLinkMachine(request, [loading(desktop), { ...pi, snapshot: { ...pi.snapshot, machine: { id: desktop.machine.id } } }]).state, "waiting", "a canonical alias must not override the requested provisioned connection")

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function navigation(query = search, sessions = [session]) {
  const opened = []
  const notices = []
  const calls = []
  let consumed = 0
  const nav = createNativeSessionDeepLinkNavigation(query, {
    open: (target) => opened.push(target),
    notice: (notice) => notices.push(notice),
    consume: () => { consumed += 1 },
    client: {
      async listGlobalSessions(config) { calls.push(["global", config]); return await sessions },
      async listSessions(config) { calls.push(["stable", config]); return await sessions },
      async listStatuses(config) { calls.push(["status", config]); return {} }
    }
  })
  return { nav, opened, notices, calls, get consumed() { return consumed } }
}

const pending = deferred()
const linked = navigation(search, pending.promise)
linked.nav.reconcile([loading(desktop), loading(pi)])
assert.equal(linked.calls.length, 0)
const read = linked.nav.reconcile([desktop, loading(pi)])
assert.equal(linked.calls.length, 1, "target discovery starts without waiting for the other daemon")
assert.equal(linked.opened.length, 0, "must not open before the authoritative list returns")
assert.equal(linked.nav.reconcile([desktop, offline(pi)]), read, "unrelated host changes reuse the in-flight lookup")
assert.equal(linked.calls.length, 1)
pending.resolve([{ ...session, id: "wrong-first-session" }, session])
await read
assert.equal(linked.opened.length, 1)
const target = linked.opened[0]
assert.equal(target.sessionID, sessionID)
assert.equal(target.machineID, "daemon-desktop")
assert.equal(target.key, `daemon-desktop:copilot:${sessionID}`)
assert.equal(target.directory, "/authoritative/repo")
assert.equal(target.ref.directory, "/authoritative/repo")
assert.equal(target.config.proxyPath, "/api/harness/arch-desktop")
assert.equal(target.config.agentId, "copilot")
assert.equal(target.config.backend, "copilot")
assert.equal(target.requiresExplicitClaim, true, "daemon-owned discovery does not claim the writer")
assert.deepEqual(linked.calls.map(([name]) => name), ["global", "status"], "navigation must perform reads only")
assert.equal(linked.consumed, 1)
assert.equal(linked.notices.at(-1), null)
await linked.nav.reconcile([desktop, pi])
await linked.nav.reconcile([offline(desktop), pi])
assert.equal(linked.opened.length, 1, "polling must not reopen or steal focus")
assert.equal(linked.consumed, 1)

for (const machineID of [pi.machine.id, pi.snapshot.machine.id]) {
  const onPi = navigation(`?machine=${machineID}&agent=copilot&session=${encodeURIComponent(sessionID)}`)
  await onPi.nav.reconcile([loading(desktop), pi])
  assert.equal(onPi.opened[0].machineID, "daemon-pi")
  assert.equal(onPi.opened[0].config.proxyPath, "/api/harness/pi")
}

for (const catalog of [[{ ...session, id: "wrong", title: sessionID }], [], [session, session]]) {
  const missing = navigation(search, catalog)
  await missing.nav.reconcile([desktop, loading(pi)])
  assert.equal(missing.opened.length, 0)
  assert.equal(missing.notices.at(-1).state, "error")
  assert.match(missing.notices.at(-1).message, /not found|ambiguous/)
  assert.equal(missing.consumed, 1)
}

const invalid = navigation("?session=only")
invalid.nav.reconcile([loading(desktop), loading(pi)])
assert.equal(invalid.notices.at(-1).state, "error")
assert.equal(invalid.calls.length, 0)

const failure = deferred()
const failed = navigation(search, failure.promise)
const failedRead = failed.nav.reconcile([desktop, loading(pi)])
failure.reject(new Error("Session listing failed"))
await failedRead
assert.match(failed.notices.at(-1).message, /Could not open Session link: Session listing failed/)
assert.equal(failed.opened.length, 0)
assert.equal(failed.consumed, 1)

for (const cancelBeforeLookup of [true, false]) {
  const late = deferred()
  const manual = navigation(search, late.promise)
  manual.nav.reconcile([loading(desktop), loading(pi)])
  const inFlight = cancelBeforeLookup ? undefined : manual.nav.reconcile([desktop, loading(pi)])
  manual.nav.cancel()
  late.resolve([session])
  await inFlight
  await manual.nav.reconcile([desktop, pi])
  assert.equal(manual.opened.length, 0, "late discovery cannot override a manual selection/dismissal")
  assert.equal(manual.consumed, 1)
  assert.equal(manual.notices.at(-1), null)
}

const cleanup = deferred()
const unmounted = navigation(search, cleanup.promise)
const abandoned = unmounted.nav.reconcile([desktop, loading(pi)])
unmounted.nav.dispose()
cleanup.resolve([session])
await abandoned
assert.equal(unmounted.opened.length, 0)
assert.equal(unmounted.consumed, 0, "StrictMode cleanup must leave the URL for the active mount")
const remounted = navigation()
await remounted.nav.reconcile([desktop, loading(pi)])
assert.equal(remounted.opened.length, 1)

const stale = deferred()
const removed = navigation(search, stale.promise)
const obsolete = removed.nav.reconcile([desktop, loading(pi)])
removed.nav.reconcile([offline(desktop), loading(pi)])
stale.resolve([session])
await obsolete
assert.equal(removed.opened.length, 0, "a completed lookup cannot open a now-unavailable target")
assert.equal(removed.notices.at(-1).state, "error")

const replacements = []
const browser = {
  location: { href: `https://gateway.example/agents/${search.split("#")[0]}#incident` },
  history: { state: { app: "keep" }, replaceState(...args) { replacements.push(args) } }
}
consumeNativeSessionDeepLink(search, browser)
assert.deepEqual(replacements, [[{ app: "keep" }, "", "/agents/?view=incident#incident"]])
browser.location.href = "https://gateway.example/agents/?machine=new&agent=copilot&session=new#incident"
consumeNativeSessionDeepLink(search, browser)
assert.equal(replacements.length, 1, "consuming an old link must not erase newer navigation")
assert.equal(parseNativeSessionDeepLink("?view=incident"), null, "refreshing a consumed URL must not reopen the Session")

const workspace = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
assert.match(workspace, /open: openSession/, "deep links must use the existing conversation entry point")
assert.match(workspace, /deepLinkNavigation\.current\?\.cancel\(\)/, "manual selection must cancel initial navigation")
assert.match(workspace, /probe\.then\(\(next\)[\s\S]*setRuntimes/, "publish each daemon probe before the Promise.all barrier")
assert.doesNotMatch(workspace.match(/const selectedInteractionEnabled = Boolean\([\s\S]*?\n  \)/)?.[0] || "", /sessionsDiscovered/, "a linked Session must not be gated by unrelated machine/rail discovery")
assert.match(workspace, /role=\{deepLinkNotice\.state === "error" \? "alert" : "status"\}/)

console.log("native Session deep-link parsing, discovery, one-shot navigation, cancellation and proxy tests passed")
