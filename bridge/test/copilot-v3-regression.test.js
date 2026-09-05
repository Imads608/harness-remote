import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"
import { HARNESS_PROFILES, resolveAcpLaunch } from "../src/harness-profiles.js"
import { detectBackends, resolveLaunchPlan } from "../src/launcher.js"

test("GitHub Copilot CLI is a first-class native ACP backend", () => {
  const profile = HARNESS_PROFILES.copilot
  assert.equal(profile.id, "copilot")
  assert.equal(profile.label, "GitHub Copilot CLI")
  assert.equal(profile.authMethod, "copilot-login")
  assert.equal(profile.restrictSessionsToRoots, true)
  assert.deepEqual(profile.modelVariantConfigIDs, ["reasoning_effort"])
  assert.equal(profile.capabilities.sessions, true)
  assert.equal(profile.capabilities.prompt, true)
  assert.equal(profile.capabilities.models, true)
  assert.equal(profile.capabilities.todos, false)
  assert.equal(profile.capabilities.commands, false)
  assert.equal(profile.capabilities.sessionRename, false)
  assert.equal(profile.capabilities.sessionDelete, false)
})

test("GitHub Copilot CLI launches its built-in ACP stdio server", () => {
  assert.deepEqual(resolveAcpLaunch(HARNESS_PROFILES.copilot, { find: () => "/never/used" }), {
    command: "copilot",
    args: ["--acp", "--stdio"],
    source: "harness"
  })
})

test("machine discovery detects and can explicitly select GitHub Copilot CLI", () => {
  const pathValue = ["/bin", "/tools"].join(path.delimiter)
  const existing = new Set([
    path.join("/tools", "copilot"),
    path.join("/tools", "claude"),
    path.join("/tools", "opencode")
  ])
  const detected = detectBackends({
    pathValue,
    platform: "linux",
    exists: (candidate) => existing.has(candidate),
    access: () => {}
  })
  assert.deepEqual(detected, ["claude", "copilot", "opencode"])
  assert.deepEqual(resolveLaunchPlan(["--backend", "copilot"], detected), {
    mode: "daemon",
    backend: "copilot",
    detected,
    openCode: true
  })
})

test("Copilot replay without message ids remains a coherent conversation", async () => {
  class FakeCopilotAcp extends EventEmitter {
    async listSessions() {
      return [{
        sessionId: "copilot-session",
        cwd: process.cwd(),
        title: "Copilot history",
        updatedAt: new Date().toISOString()
      }]
    }

    async request(method, params) {
      if (method !== "session/load") throw new Error(`Unexpected request: ${method}`)
      for (const [sessionUpdate, text] of [
        ["user_message_chunk", "Inspect the failing test"],
        ["agent_message_chunk", "The failure is in pagination."]
      ]) {
        this.emit("notification", {
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate, content: { type: "text", text } }
          }
        })
      }
      return {
        configOptions: [{
          id: "model",
          currentValue: "gpt-5.6-sol",
          options: [{ value: "gpt-5.6-sol" }]
        }]
      }
    }

    notify() {}
  }

  const service = new AcpService(new FakeCopilotAcp())
  const messages = await service.messages("copilot-session")
  assert.deepEqual(messages.map((message) => message.info.role), ["user", "assistant"])
  assert.deepEqual(
    messages.map((message) => message.parts.find((part) => part.type === "text")?.text),
    ["Inspect the failing test", "The failure is in pagination."]
  )
})

test("Copilot sessions and mutations stay inside configured roots", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-copilot-root-"))
  const inside = path.join(root, "project")
  const outside = await mkdtemp(path.join(tmpdir(), "harness-copilot-outside-"))
  await mkdir(inside)
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]))

  class RootAwareAcp extends EventEmitter {
    notifications = []

    async start() {}

    async listSessions() {
      return [
        { sessionId: "inside", cwd: inside, title: "Inside", updatedAt: new Date().toISOString() },
        { sessionId: "outside", cwd: outside, title: "Outside", updatedAt: new Date().toISOString() }
      ]
    }

    async request(method, params) {
      if (method === "session/new") return { sessionId: "created", configOptions: [] }
      if (method === "session/load") return { configOptions: [] }
      throw new Error(`Unexpected request: ${method} ${JSON.stringify(params)}`)
    }

    notify(method, params) {
      this.notifications.push({ method, params })
    }
  }

  const acp = new RootAwareAcp()
  const service = new AcpService(acp, { sessionRoots: [root] })
  assert.deepEqual((await service.listSessions()).map((session) => session.id), ["inside"])
  assert.deepEqual((await service.sessionIndex()).map((session) => session.sessionId), ["inside"])
  await assert.rejects(service.messages("outside"), /Harness session not found/)
  await assert.rejects(
    service.createSession({ directory: outside, title: "Blocked" }),
    /outside the configured --root boundary/
  )
  await assert.rejects(service.abort("outside"), /Harness session not found/)

  const created = await service.createSession({ directory: inside, title: "Allowed" })
  assert.equal(created.id, "created")
  await assert.doesNotReject(service.abort("created"))
  assert.deepEqual(acp.notifications, [{
    method: "session/cancel",
    params: { sessionId: "created" }
  }])
})

test("Copilot revalidates a cached session after its native cwd leaves the root", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-copilot-revalidate-root-"))
  const inside = path.join(root, "project")
  const outside = await mkdtemp(path.join(tmpdir(), "harness-copilot-revalidate-outside-"))
  await mkdir(inside)
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]))

  class MovingSessionAcp extends EventEmitter {
    cwd = inside
    loads = 0

    async listSessions() {
      return [{
        sessionId: "moving",
        cwd: this.cwd,
        title: "Moving",
        updatedAt: new Date().toISOString()
      }]
    }

    async request(method) {
      if (method === "session/load") {
        this.loads += 1
        return { configOptions: [] }
      }
      throw new Error(`Unexpected request: ${method}`)
    }

    notify() {}
  }

  const acp = new MovingSessionAcp()
  const service = new AcpService(acp, { sessionRoots: [root] })
  assert.deepEqual((await service.sessionIndex()).map((session) => session.sessionId), ["moving"])

  acp.cwd = outside
  assert.deepEqual(await service.sessionIndex(), [])
  await assert.rejects(service.models("moving"), /Harness session not found/)
  assert.equal(await service.adoptTaskSession("moving"), false)
  await assert.rejects(service.abort("moving"), /Harness session not found/)
  assert.equal(acp.loads, 0, "an excluded cached Session must never be loaded")
})
