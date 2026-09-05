import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

class FakeAcp extends EventEmitter {
  constructor() {
    super()
    this.requests = []
    this.notifications = []
    this.failLoads = 0
    this.promptCapabilities = { image: false }
  }

  async start() {}

  async listSessions() {
    return [{
      sessionId: "native-1",
      cwd: "/repo",
      title: "Native Session",
      updatedAt: "2026-08-24T10:00:00.000Z"
    }]
  }

  async request(method, params) {
    this.requests.push([method, params])
    if (method === "session/load") {
      if (this.failLoads > 0) {
        this.failLoads -= 1
        throw new Error("session is already active in another writer")
      }
      return {
        configOptions: [{
          id: "model",
          currentValue: "model-a",
          options: [{ value: "model-a", name: "Model A" }]
        }]
      }
    }
    return {}
  }

  notify(method, params) {
    this.notifications.push([method, params])
  }
}

function persistedAssistantMessage() {
  return {
    info: {
      id: "persisted-assistant",
      role: "assistant",
      sessionID: "native-1",
      time: { created: 1 }
    },
    parts: [{ id: "persisted-text", type: "text", text: "Existing native history" }]
  }
}

function journalLoader() {
  const loader = async () => [persistedAssistantMessage()]
  loader.claimOnLoad = false
  return loader
}

function loadRequests(acp) {
  return acp.requests.filter(([method]) => method === "session/load")
}

test("journal observation stays read-only until explicit claim, then prompt reuses the acquired writer", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp, { historyLoader: journalLoader() })

  const observed = await service.messages("native-1")
  assert.equal(observed.length, 1)
  assert.equal(loadRequests(acp).length, 0, "reading native journal history must not acquire the ACP writer")
  assert.equal((await service.listSessions())[0].external, true)

  assert.equal(await service.claimSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 1)
  assert.equal((await service.listSessions())[0].external, undefined)

  assert.equal(await service.claimSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 1, "repeated explicit claim must be idempotent")

  await service.prompt("native-1", "Continue in this exact Session")
  assert.equal(loadRequests(acp).length, 1, "the first prompt after claim must not acquire the writer again")
  assert.equal(acp.requests.filter(([method]) => method === "session/prompt").length, 1)
})

test("failed writer acquisition does not leave phantom ownership and can be retried", async () => {
  const acp = new FakeAcp()
  acp.failLoads = 1
  const service = new AcpService(acp, { historyLoader: journalLoader() })

  await service.messages("native-1")
  await assert.rejects(
    () => service.claimSession("native-1"),
    /active in another writer/
  )
  assert.equal(loadRequests(acp).length, 1)
  assert.equal((await service.listSessions())[0].external, true)
  await assert.rejects(service.abort("native-1"), /not active in the app/)

  assert.equal(await service.claimSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 2)
  await assert.doesNotReject(service.abort("native-1"))
  assert.deepEqual(acp.notifications.at(-1), ["session/cancel", { sessionId: "native-1" }])
})

test("compatibility adoption never substitutes for a real Session-first writer claim", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp, { historyLoader: journalLoader() })

  assert.equal(await service.adoptTaskSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 0)

  assert.equal(await service.claimSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 1, "an adopted Task session must still perform native session/load when explicitly claimed")
})

test("an ACP Session already opened successfully by this daemon can be claimed without a second load", async () => {
  const acp = new FakeAcp()
  const service = new AcpService(acp)

  await service.messages("native-1")
  assert.equal(loadRequests(acp).length, 1)
  assert.equal(await service.claimSession("native-1"), true)
  assert.equal(loadRequests(acp).length, 1)
})

test("claim refuses a native Session that no longer exists", async () => {
  const acp = new FakeAcp()
  acp.listSessions = async () => []
  const service = new AcpService(acp)
  await assert.rejects(() => service.claimSession("missing"), /Harness session not found/)
  assert.equal(loadRequests(acp).length, 0)
})
