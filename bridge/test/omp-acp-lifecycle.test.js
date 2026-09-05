import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpPromptEchoFilter } from "../src/acp-prompt-echo-filter.js"
import { AcpService } from "../src/acp-service.js"
import { HARNESS_PROFILES } from "../src/harness-profiles.js"
import { createOmpHistoryLoader } from "../src/omp-session-history.js"
import { FakeOmpAcp } from "./helpers/fake-omp-acp.js"

/**
 * The OMP Session lifecycle, driven end to end through the same objects the daemon builds.
 *
 * These cases are written against the multi-turn behaviour a person actually exercises - send,
 * read the answer, send again, leave and come back - because a suite that only proves the first
 * prompt cannot see the failure that made the second one appear blank.
 */

const profile = HARNESS_PROFILES.omp

async function harness({ sessionRoot } = {}) {
  const root = sessionRoot ?? await mkdtemp(path.join(tmpdir(), "harness-remote-omp-lifecycle-"))
  const acp = new FakeOmpAcp({ sessionRoot: root })
  const service = new AcpService(new AcpPromptEchoFilter(acp), {
    historyLoader: createOmpHistoryLoader(root),
    preserveListedTimestamps: profile.preserveListedTimestamps,
    reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh,
    replaySettleMs: profile.replaySettleMs,
    preferListedTitles: profile.preferListedTitles,
    journalPageWhileOwned: profile.journalPageWhileOwned !== false,
    nativeRenameCommand: profile.nativeRenameCommand,
    modelVariantConfigIDs: profile.modelVariantConfigIDs ?? []
  })
  return { root, acp, service, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** What the app reads: the newest page of the transcript. */
async function tail(service, sessionID) {
  return (await service.messagePage(sessionID, { limit: 200 })).messages
}

function shape(messages) {
  return messages.map((message) => [
    message.info.role,
    message.parts.map((part) => part.type === "tool" ? `tool:${part.tool}:${part.state.status}` : `${part.type}:${part.text ?? ""}`)
  ])
}

function ids(messages) {
  return messages.map((message) => message.info.id)
}

test("a new OMP Session answers its first prompt and every prompt after it", async () => {
  const { acp, service, cleanup } = await harness()
  try {
    const created = await service.createSession({ directory: "/repo", title: "Rebuild" })
    const sessionID = created.id

    const seen = []
    for (let turn = 1; turn <= 5; turn += 1) {
      acp.queueTurn({
        reasoning: [`Thinking about ${turn}`],
        tools: [{ id: `call-${turn}`, name: "read", input: { path: `file-${turn}.ts` }, output: `contents ${turn}` }],
        text: [`Answer ${turn} `, "part two"]
      })
      await service.promptAndWait(sessionID, `Prompt ${turn}`)
      seen.push(shape(await tail(service, sessionID)))
    }

    const final = await tail(service, sessionID)
    assert.deepEqual(
      final.filter((message) => message.info.role === "user").map((message) => message.parts[0].text),
      ["Prompt 1", "Prompt 2", "Prompt 3", "Prompt 4", "Prompt 5"],
      "five prompts must produce five turns in one Session"
    )
    const answers = final
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text))
    assert.deepEqual(
      answers,
      [1, 2, 3, 4, 5].map((turn) => `Answer ${turn} part two`),
      "every answer must converge on its complete text, last chunk included"
    )
    assert.equal(new Set(ids(final)).size, final.length, "no message may appear twice")
    assert.equal(acp.calls("session/load").length, 0, "a Session this bridge created is never replayed back to it")
    assert.equal(service.status(sessionID).type, "idle")

    // Every intermediate read is a prefix of the next: nothing is re-identified between turns, which
    // is what lets the app reconcile pages by id without inventing a second copy of a turn.
    for (let index = 1; index < seen.length; index += 1) {
      assert.deepEqual(seen[index].slice(0, seen[index - 1].length), seen[index - 1], `turn ${index + 1} must extend turn ${index}`)
    }
  } finally {
    await cleanup()
  }
})

test("reasoning, tool activity and text are readable while the turn is still running", async () => {
  const { acp, service, cleanup } = await harness()
  try {
    const sessionID = (await service.createSession({ directory: "/repo" })).id
    acp.queueTurn({ reasoning: ["First I look"], tools: [{ id: "call-a", name: "grep" }], text: ["Done"] })
    await service.promptAndWait(sessionID, "Prompt 1")

    const during = []
    acp.queueTurn({ reasoning: ["Second I look"], tools: [{ id: "call-b", name: "edit" }], text: ["Fixed"] })
    const unsubscribe = service.subscribe(async (event) => {
      if (event.sessionId !== sessionID || event.type !== "message.updated") return
      during.push(shape(await tail(service, sessionID)))
    })
    await service.promptAndWait(sessionID, "Prompt 2")
    unsubscribe()

    const streamed = during.flat().flatMap(([, parts]) => parts)
    assert.ok(streamed.includes("reasoning:Second I look"), "reasoning must be visible while the second turn runs")
    assert.ok(streamed.some((part) => part.startsWith("tool:edit")), "tool activity must be visible while the second turn runs")
    assert.ok(streamed.includes("text:Fixed"), "the answer must be visible while the second turn runs")

    const settled = await tail(service, sessionID)
    assert.ok(
      settled.every((message) => message.parts.every((part) => part.type !== "tool" || part.state.status !== "running")),
      "no Activity may still read as Working once the turn ended"
    )
  } finally {
    await cleanup()
  }
})

test("leaving and returning during a turn does not re-identify or duplicate the conversation", async () => {
  const { acp, service, cleanup } = await harness()
  try {
    const sessionID = (await service.createSession({ directory: "/repo" })).id
    acp.queueTurn({ text: ["First answer"] })
    await service.promptAndWait(sessionID, "Prompt 1")
    const afterFirst = ids(await tail(service, sessionID))

    // Navigating away and back is a fresh read of the same Session, both while it is working and
    // once it is Ready. Neither may hand the app a different identity for a message it already has.
    const mid = []
    acp.queueTurn({ reasoning: ["Working"], text: ["Second answer"] })
    const unsubscribe = service.subscribe(async (event) => {
      if (event.sessionId === sessionID && event.type === "message.updated") mid.push(ids(await tail(service, sessionID)))
    })
    await service.promptAndWait(sessionID, "Prompt 2")
    unsubscribe()

    const afterSecond = ids(await tail(service, sessionID))
    assert.deepEqual(afterSecond.slice(0, afterFirst.length), afterFirst, "the first turn keeps its identity across the second")
    for (const snapshot of mid) {
      assert.deepEqual(snapshot.slice(0, afterFirst.length), afterFirst, "a read taken mid-turn agrees with the settled one")
    }
    assert.deepEqual(await tail(service, sessionID), await tail(service, sessionID), "repeated reads are stable")
  } finally {
    await cleanup()
  }
})

test("two prompts with identical text stay two turns", async () => {
  const { acp, service, cleanup } = await harness()
  try {
    const sessionID = (await service.createSession({ directory: "/repo" })).id
    acp.queueTurn({ text: ["One"] })
    await service.promptAndWait(sessionID, "Same question")
    acp.queueTurn({ text: ["Two"] })
    await service.promptAndWait(sessionID, "Same question")

    const messages = await tail(service, sessionID)
    assert.deepEqual(shape(messages), [
      ["user", ["text:Same question"]],
      ["assistant", ["text:One"]],
      ["user", ["text:Same question"]],
      ["assistant", ["text:Two"]]
    ], "repeated prompts must not be collapsed into one turn")
    assert.equal(new Set(ids(messages)).size, 4)
  } finally {
    await cleanup()
  }
})

test("an existing OMP Session is resumed rather than replayed, and continues without duplicating itself", async () => {
  const { acp, service, cleanup } = await harness()
  try {
    await acp.seedSession("stored-1", {
      title: "Written by OMP itself",
      entries: [
        { type: "message", id: "e1", parentId: null, timestamp: "2026-08-26T10:00:00.000Z", message: { role: "user", content: "Earlier question" } },
        { type: "message", id: "e2", parentId: "e1", timestamp: "2026-08-26T10:00:01.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4", content: [{ type: "text", text: "Earlier answer" }] } }
      ]
    })

    const observed = await tail(service, "stored-1")
    assert.deepEqual(shape(observed), [
      ["user", ["text:Earlier question"]],
      ["assistant", ["text:Earlier answer"]]
    ], "an OMP Session opened elsewhere is readable without opening it here")
    assert.equal(acp.calls("session/load").length + acp.calls("session/resume").length, 0, "reading must not acquire the writer")

    assert.equal(await service.claimSession("stored-1"), true)
    assert.equal(acp.calls("session/resume").length, 1, "taking the writer uses the non-replaying open")
    assert.equal(acp.calls("session/load").length, 0, "session/load would replay the whole transcript under new ids")

    acp.queueTurn({ text: ["Later answer"] })
    await service.promptAndWait("stored-1", "Later question")

    const continued = await tail(service, "stored-1")
    assert.deepEqual(shape(continued), [
      ["user", ["text:Earlier question"]],
      ["assistant", ["text:Earlier answer"]],
      ["user", ["text:Later question"]],
      ["assistant", ["text:Later answer"]]
    ], "continuing a stored Session must neither replay nor duplicate its history")
    assert.deepEqual(ids(continued).slice(0, 2), ["e1", "e2"], "the stored turns keep the identity the journal gave them")
    assert.equal(acp.calls("session/load").length, 0)
  } finally {
    await cleanup()
  }
})

test("continuing on the same model sends no model mutation, and a real change sends exactly one", async () => {
  const { acp, service, cleanup } = await harness()
  try {
    const sessionID = (await service.createSession({ directory: "/repo" })).id
    const mutations = () => acp.calls("session/set_config_option").filter(([, params]) => params.configId === "model")

    acp.queueTurn({ text: ["One"] })
    await service.promptAndWait(sessionID, "Prompt 1", "anthropic/claude-sonnet-4")
    assert.equal(mutations().length, 0, "the Session already holds this model")

    acp.queueTurn({ text: ["Two"] })
    await service.promptAndWait(sessionID, "Prompt 2", "anthropic/claude-sonnet-4")
    assert.equal(mutations().length, 0, "continuing on the same model is not a model change")

    acp.queueTurn({ text: ["Three"] })
    await service.promptAndWait(sessionID, "Prompt 3", "openai/gpt-5.6")
    assert.equal(mutations().length, 1, "a real switch is applied once")

    const page = await service.messagePage(sessionID, { limit: 200 })
    assert.deepEqual(
      page.model,
      { providerID: "openai", modelID: "gpt-5.6", variant: "off" },
      "the page reports the model the Session now holds, with the reasoning level it is set to"
    )
  } finally {
    await cleanup()
  }
})

test("the reported model carries the reasoning variant the Session holds", async () => {
  const { acp, service, cleanup } = await harness()
  try {
    const sessionID = (await service.createSession({ directory: "/repo" })).id
    await service.setModel(sessionID, "openai/gpt-5.6", { configId: "thinking", value: "high" })
    const page = await service.messagePage(sessionID, { limit: 10 })
    assert.deepEqual(page.model, { providerID: "openai", modelID: "gpt-5.6", variant: "high" })
  } finally {
    await cleanup()
  }
})

test("cancelling a turn leaves no invented interruption in the transcript", async () => {
  const { acp, service, cleanup } = await harness()
  try {
    const sessionID = (await service.createSession({ directory: "/repo" })).id
    acp.queueTurn({ reasoning: ["Half a thought"], text: ["Never sent"] })
    const running = service.promptAndWait(sessionID, "Prompt 1").catch(() => undefined)
    await service.abort(sessionID)
    await running

    assert.equal(service.status(sessionID).type, "idle", "a cancelled Session must read Ready")
    const messages = await tail(service, sessionID)
    assert.ok(
      messages.every((message) => !message.info.error),
      "OMP's own abort reason is one its renderers suppress, so it must not become a red banner here"
    )

    acp.queueTurn({ text: ["Answer after stop"] })
    await service.promptAndWait(sessionID, "Prompt 2")
    const continued = await tail(service, sessionID)
    assert.ok(
      continued.some((message) => message.parts.some((part) => part.text === "Answer after stop")),
      "a Session must keep working after a Stop"
    )
  } finally {
    await cleanup()
  }
})

test("an OMP build without session/resume still opens through session/load", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-legacy-"))
  try {
    const acp = new FakeOmpAcp({ sessionRoot: root })
    // OMP advertised `sessionCapabilities` only from the release that added resume; an installation
    // that predates it must keep working on the method it does offer.
    acp.sessionCapabilities = {}
    const service = new AcpService(new AcpPromptEchoFilter(acp), {
      historyLoader: createOmpHistoryLoader(root),
      reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh,
      journalPageWhileOwned: false,
      modelVariantConfigIDs: profile.modelVariantConfigIDs
    })
    await acp.seedSession("stored-legacy", {
      entries: [
        { type: "message", id: "e1", parentId: null, timestamp: "2026-08-26T10:00:00.000Z", message: { role: "user", content: "Earlier question" } },
        { type: "message", id: "e2", parentId: "e1", timestamp: "2026-08-26T10:00:01.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4", content: [{ type: "text", text: "Earlier answer" }] } }
      ]
    })

    assert.equal(await service.claimSession("stored-legacy"), true)
    assert.equal(acp.calls("session/load").length, 1)
    acp.queueTurn({ text: ["Later answer"] })
    await service.promptAndWait("stored-legacy", "Later question")
    const messages = await tail(service, "stored-legacy")
    assert.deepEqual(
      messages.filter((message) => message.info.role === "user").map((message) => message.parts[0].text),
      ["Earlier question", "Later question"],
      "the replay a legacy open produces must not double the history the journal already supplied"
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an OMP Session whose journal predates the entry tree is readable before OMP migrates it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-v1-"))
  try {
    const acp = new FakeOmpAcp({ sessionRoot: root })
    const service = new AcpService(new AcpPromptEchoFilter(acp), {
      historyLoader: createOmpHistoryLoader(root),
      reloadOnHistoryRefresh: false,
      journalPageWhileOwned: false
    })
    // A v1 journal: no title slot, no version on the header, and no `id`/`parentId` anywhere.
    const lines = [
      { type: "session", id: "v1-session", timestamp: "2026-01-02T10:00:00.000Z", cwd: "/repo" },
      { type: "message", timestamp: "2026-01-02T10:00:01.000Z", message: { role: "user", content: "Old question" } },
      { type: "message", timestamp: "2026-01-02T10:00:02.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4", content: [{ type: "text", text: "Old answer" }] } }
    ]
    await writeFile(path.join(root, "2026-01-02_v1-session.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)

    const messages = await tail(service, "v1-session")
    assert.deepEqual(shape(messages), [
      ["user", ["text:Old question"]],
      ["assistant", ["text:Old answer"]]
    ], "an unmigrated Session must not read as empty")
    assert.deepEqual(ids(await tail(service, "v1-session")), ids(messages), "its ids must be stable across reads")
    assert.equal(acp.calls("session/load").length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a Session whose journal has not been created yet still answers its first prompt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-lazy-"))
  try {
    const acp = new FakeOmpAcp({ sessionRoot: root })
    const service = new AcpService(new AcpPromptEchoFilter(acp), {
      historyLoader: createOmpHistoryLoader(root),
      reloadOnHistoryRefresh: false,
      journalPageWhileOwned: false
    })
    // The lookup misses before OMP writes anything, which used to be remembered as "no such
    // Session" for as long as the bridge ran.
    assert.deepEqual(await tail(service, "omp-1"), [])
    const sessionID = (await service.createSession({ directory: "/repo" })).id
    acp.queueTurn({ text: ["First answer"] })
    await service.promptAndWait(sessionID, "First question")
    assert.deepEqual(shape(await tail(service, sessionID)), [
      ["user", ["text:First question"]],
      ["assistant", ["text:First answer"]]
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("taking the writer picks up what OMP wrote on its own in the meantime", async () => {
  const { acp, service, cleanup } = await harness()
  try {
    await acp.seedSession("stored-2", {
      entries: [
        { type: "message", id: "e1", parentId: null, timestamp: "2026-08-26T10:00:00.000Z", message: { role: "user", content: "First question" } },
        { type: "message", id: "e2", parentId: "e1", timestamp: "2026-08-26T10:00:01.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4", content: [{ type: "text", text: "First answer" }] } }
      ]
    })
    assert.equal((await tail(service, "stored-2")).length, 2)

    // The user keeps talking to OMP directly while the Session is only being observed here.
    await acp.seedSession("stored-2", {
      entries: [
        { type: "message", id: "e1", parentId: null, timestamp: "2026-08-26T10:00:00.000Z", message: { role: "user", content: "First question" } },
        { type: "message", id: "e2", parentId: "e1", timestamp: "2026-08-26T10:00:01.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4", content: [{ type: "text", text: "First answer" }] } },
        { type: "message", id: "e3", parentId: "e2", timestamp: "2026-08-26T10:00:02.000Z", message: { role: "user", content: "Second question" } },
        { type: "message", id: "e4", parentId: "e3", timestamp: "2026-08-26T10:00:03.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4", content: [{ type: "text", text: "Second answer" }] } }
      ]
    })
    assert.equal((await tail(service, "stored-2")).length, 4, "an observed Session keeps following its journal")

    await service.claimSession("stored-2")
    acp.queueTurn({ text: ["Third answer"] })
    await service.promptAndWait("stored-2", "Third question")
    assert.deepEqual(
      (await tail(service, "stored-2")).map((message) => message.parts[0].text),
      ["First question", "First answer", "Second question", "Second answer", "Third question", "Third answer"],
      "continuing must build on everything OMP had written, and repeat none of it"
    )
  } finally {
    await cleanup()
  }
})

test("an unreadable journal is reported rather than answered with an empty conversation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-remote-omp-unreadable-"))
  try {
    const acp = new FakeOmpAcp({ sessionRoot: root })
    const loader = async () => { throw new Error("EIO") }
    loader.journalOnly = true
    loader.page = async () => { throw new Error("EIO") }
    const service = new AcpService(new AcpPromptEchoFilter(acp), {
      historyLoader: loader,
      reloadOnHistoryRefresh: false,
      journalPageWhileOwned: false
    })
    await acp.seedSession("stored-broken", { entries: [] })

    await assert.rejects(() => service.messagePage("stored-broken", { limit: 100 }), /EIO/)
    assert.equal(acp.calls("session/load").length, 0, "a replay is not a fallback for a read that failed")
    assert.equal(acp.calls("session/resume").length, 0, "and neither is acquiring the writer")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the name a Session is created with is stored by OMP, not only here", async () => {
  const { root, acp, service, cleanup } = await harness()
  try {
    const created = await service.createSession({ directory: "/repo", title: "Rebuild the ACP path" })
    assert.equal(created.title, "Rebuild the ACP path")

    const renames = acp.calls("session/prompt").filter(([, params]) => params.prompt?.[0]?.text?.startsWith("/rename "))
    assert.equal(renames.length, 1, "session/new carries no title, so the name is handed over as the harness's own command")
    assert.equal((await acp.listSessions())[0].title, "Rebuild the ACP path", "OMP itself must know the name")
    assert.deepEqual(await tail(service, created.id), [], "naming a Session is not a turn in it")

    acp.queueTurn({ text: ["Answer"] })
    await service.promptAndWait(created.id, "Prompt 1")
    assert.equal((await service.listSessions())[0].title, "Rebuild the ACP path", "and it survives the first turn")

    // A second bridge over the same OMP sees the name because OMP is where it lives, not because
    // this process remembered it.
    const second = new AcpService(new AcpPromptEchoFilter(acp), {
      historyLoader: createOmpHistoryLoader(root),
      reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh,
      preferListedTitles: profile.preferListedTitles,
      journalPageWhileOwned: false,
      nativeRenameCommand: profile.nativeRenameCommand
    })
    assert.equal((await second.listSessions())[0].title, "Rebuild the ACP path")
  } finally {
    await cleanup()
  }
})

test("renaming a Session later persists the same way and leaves no trace in the conversation", async () => {
  const { acp, service, cleanup } = await harness()
  try {
    const sessionID = (await service.createSession({ directory: "/repo" })).id
    acp.queueTurn({ text: ["Answer"] })
    await service.promptAndWait(sessionID, "Prompt 1")
    const before = await tail(service, sessionID)

    const renamed = await service.renameSession(sessionID, "Named after the fact")
    assert.equal(renamed.title, "Named after the fact")
    assert.equal((await acp.listSessions())[0].title, "Named after the fact")
    assert.equal((await service.listSessions())[0].title, "Named after the fact")
    assert.deepEqual(await tail(service, sessionID), before, "the harness's confirmation line is not conversation")
    assert.equal(service.status(sessionID).type, "idle", "renaming must not leave the Session reading as Working")

    acp.queueTurn({ text: ["Second answer"] })
    await service.promptAndWait(sessionID, "Prompt 2")
    assert.equal((await service.listSessions())[0].title, "Named after the fact", "and later turns keep it")
  } finally {
    await cleanup()
  }
})

test("a Session named in OMP itself keeps that name here", async () => {
  const { acp, service, cleanup } = await harness()
  try {
    await acp.seedSession("stored-named", {
      title: "Written in the OMP TUI",
      entries: [
        { type: "message", id: "e1", parentId: null, timestamp: "2026-08-26T10:00:00.000Z", message: { role: "user", content: "Question" } }
      ]
    })
    assert.equal((await service.listSessions()).find((session) => session.id === "stored-named").title, "Written in the OMP TUI")
  } finally {
    await cleanup()
  }
})
