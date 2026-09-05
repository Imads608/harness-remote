import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { sessionTreeRows } from "./components/native-session-home.tsx"
import { canCreateNativeSession } from "./native-session-create.ts"

function item(id, parentID) {
  return {
    machine: { id: "machine-1", name: "Machine" },
    record: {
      key: id,
      agentId: "opencode",
      agentLabel: "OpenCode",
      backend: "opencode",
      transport: "http",
      abortSupported: true,
      modelsSupported: true,
      session: {
        id,
        parentID,
        title: id,
        directory: "/repo",
        time: { created: 1, updated: 1 }
      }
    }
  }
}

const rows = sessionTreeRows([
  item("child-2", "root"),
  item("root"),
  item("orphan", "missing"),
  item("child-1", "root"),
  item("cycle-a", "cycle-b"),
  item("cycle-b", "cycle-a"),
  item("self", "self")
])

assert.deepEqual(rows.map(({ item: row, depth }) => [row.record.session.id, depth]), [
  ["root", 0],
  ["child-2", 1],
  ["child-1", 1],
  ["orphan", 0],
  ["self", 0],
  ["cycle-a", 0],
  ["cycle-b", 1]
])
assert.equal(new Set(rows.map(({ item: row }) => row.record.session.id)).size, 7, "cycles or missing parents must never hide or duplicate a native Session")

for (const [backend, transport] of [
  ["opencode", "http"],
  ["omp", "acp"],
  ["pi", "acp"],
  ["claude", "acp"],
  ["codex", "acp"],
  ["copilot", "acp"]
]) {
  assert.equal(canCreateNativeSession({
    id: backend,
    label: backend,
    backend,
    transport,
    managed: true,
    state: "available",
    capabilities: { sessions: true, prompt: true }
  }), true, `${backend} must be available in New Session when its native transport is writable`)
}

assert.equal(canCreateNativeSession({
  id: "claude",
  label: "Claude",
  backend: "claude",
  transport: "acp",
  managed: true,
  state: "unavailable",
  capabilities: { sessions: true, prompt: true }
}), false, "an unavailable harness must not be offered for native create")

const source = readFileSync(new URL("./components/native-session-home.tsx", import.meta.url), "utf8")
assert.match(source, /presentationOverrides/, "live detail status must survive selecting another Session")
assert.match(source, /\{ \.\.\.current, \[selectedKey\]: selectedState \}/, "the status bridge must be keyed by native Session identity")
assert.match(source, /setPresentationOverrides\(\{\}\)[\s\S]*setRecords\(results\.flatMap/, "a successful native discovery must retire temporary presentation overrides")
assert.match(source, /presentationOverrides\[targetKey\]/, "non-selected rows must retain their last observed live state until discovery reconciles them")
assert.match(source, /createMachineID/, "native Session creation must have an explicit machine selection independent of the list filter")
assert.match(source, /createMachines\.map/, "the create panel must render the available machine choices")
assert.match(source, /selectedActivityAnchor/, "the currently open Session must keep a stable activity ordering anchor")
assert.match(source, /activityTimestamp\(item, anchor\)/, "Project and Machine ordering must use the same selected-Session activity anchor")
assert.match(source, /setExpandedProjects/, "a selected Session below the compact preview must be made visible")
assert.match(source, /scrollIntoView\(\{ block: "nearest"/, "the selected Session must be kept in the visible list viewport")
assert.match(source, /recentlyCompletedKey/, "Working to Ready must leave a brief completion affordance")
assert.match(source, /snapshot && state === "online" && !error/, "a reconnect-grace machine must not remain writable just because its last snapshot is cached")
assert.match(source, /disabled=\{!loaded \|\| createMachines\.length === 0\}/, "New Session must stay disabled until Session and Project bootstrap has settled")
assert.match(source, /if \(!loaded \|\| createMachines\.length === 0\) return/, "the create handler must enforce the same bootstrap gate as the button")
assert.match(source, /t\("sf\.loadingSessions"\)/, "the empty rail must say Sessions are loading instead of implying the machine is disconnected")
assert.match(source, /const discoveryReady = sources\.every\(\(\{ state \}\) => state !== "loading"\)/, "Session discovery must not settle while machine probes are still in flight")
assert.match(source, /if \(!discoveryReady\) \{[\s\S]*setLoading\(true\)[\s\S]*return/, "the rail must remain explicitly loading until machine discovery can produce real Session results")

console.log("native Session Home tree, create parity and stable-selection UX tests passed")
