import {
  discoverAgentNativeSessions,
  nativeSessionSurfaceTarget,
  type NativeSessionReadApi,
  type NativeSessionSurfaceTarget
} from "./native-session-discovery"
import type { MachineAgentHost, MachineSnapshot } from "./types"
import type { WorkspaceMachine } from "./workspaceMachines"

const LINK_PARAMS = ["machine", "agent", "session"] as const

type SessionLink = {
  machineID: string
  agentID: string
  sessionID: string
}

export type NativeSessionDeepLink = { request: SessionLink } | { error: string } | null
export type DeepLinkNotice = { state: "loading" | "error"; message: string } | null
export type DeepLinkMachine = {
  machine: WorkspaceMachine
  snapshot: MachineSnapshot | null
  state: "loading" | "online" | "offline"
  error?: string
}

export function parseNativeSessionDeepLink(search: string): NativeSessionDeepLink {
  const params = new URLSearchParams(search)
  if (!LINK_PARAMS.some((key) => params.has(key))) return null
  if (LINK_PARAMS.some((key) => params.getAll(key).length !== 1 || !params.get(key)?.trim())) {
    return { error: "Invalid Session link: provide exactly one machine, agent and session." }
  }
  return {
    request: {
      machineID: params.get("machine")!,
      agentID: params.get("agent")!,
      sessionID: params.get("session")!
    }
  }
}

type Resolution =
  | { state: "waiting" }
  | { state: "error"; message: string }
  | { state: "ready"; runtime: DeepLinkMachine; agent: MachineAgentHost }

export function resolveDeepLinkMachine(link: SessionLink, sources: DeepLinkMachine[]): Resolution {
  // The provisioned/saved connection id wins over any coincidentally equal daemon id.
  const configured = sources.filter(({ machine }) => machine.id === link.machineID)
  const matches = configured.length ? configured : sources.filter(({ snapshot }) => snapshot?.machine.id === link.machineID)
  if (matches.length > 1) return { state: "error", message: `Session link machine "${link.machineID}" is ambiguous.` }
  const runtime = matches[0]
  if (!runtime) {
    // An unknown id may still be the canonical identity of a daemon whose probe is in flight.
    if (sources.some(({ state }) => state === "loading")) return { state: "waiting" }
    return { state: "error", message: `Session link machine "${link.machineID}" was not found among the configured machines.` }
  }
  if (runtime.state === "loading") return { state: "waiting" }
  if (runtime.state !== "online" || !runtime.snapshot || runtime.error) {
    return { state: "error", message: `Session link machine "${runtime.machine.name}" is unavailable. ${runtime.error || "Check its connection and reopen the link."}` }
  }
  const agent = runtime.snapshot.agents.find((candidate) => candidate.id === link.agentID)
  if (!agent) return { state: "error", message: `Session link agent "${link.agentID}" was not found on "${runtime.machine.name}".` }
  if (agent.capabilities.sessions === false) {
    return { state: "error", message: `Session link agent "${link.agentID}" does not support native Session discovery.` }
  }
  return { state: "ready", runtime, agent }
}

/** Remove only the captured link, never a newer navigation or unrelated query/hash state. */
export function consumeNativeSessionDeepLink(search: string, browser: Pick<Window, "location" | "history"> = window): void {
  const captured = new URLSearchParams(search)
  const url = new URL(browser.location.href)
  if (!LINK_PARAMS.some((key) => captured.has(key))) return
  if (LINK_PARAMS.some((key) => JSON.stringify(captured.getAll(key)) !== JSON.stringify(url.searchParams.getAll(key)))) return
  for (const key of [...LINK_PARAMS, "directory"]) url.searchParams.delete(key)
  browser.history.replaceState(browser.history.state, "", `${url.pathname}${url.search}${url.hash}`)
}

/**
 * One initial, read-only navigation. Independent machine updates may reconcile it repeatedly;
 * neither a late read nor polling may override a subsequent manual selection.
 */
export function createNativeSessionDeepLinkNavigation(search: string, callbacks: {
  open: (target: NativeSessionSurfaceTarget) => void
  notice: (notice: DeepLinkNotice) => void
  consume: () => void
  client?: NativeSessionReadApi
}) {
  const parsed = parseNativeSessionDeepLink(search)
  let settled = parsed === null
  let generation = 0
  let lookup: { runtime: DeepLinkMachine; promise: Promise<void> } | null = null

  function finish() {
    settled = true
    // Some embedded/private browsers restrict history writes. The in-memory once guard still holds.
    try { callbacks.consume() } catch { /* navigation must not depend on browser history access */ }
  }

  function fail(message: string) {
    finish()
    callbacks.notice({ state: "error", message })
  }

  return {
    reconcile(sources: DeepLinkMachine[]): Promise<void> | undefined {
      if (settled || !parsed) return
      if ("error" in parsed) {
        fail(parsed.error)
        return
      }
      const resolution = resolveDeepLinkMachine(parsed.request, sources)
      if (resolution.state === "error") {
        fail(resolution.message)
        return
      }
      if (resolution.state === "waiting") {
        generation += 1
        lookup = null
        callbacks.notice({ state: "loading", message: "Waiting for the linked Session's machine…" })
        return
      }
      const { runtime, agent } = resolution
      if (lookup?.runtime.machine.config === runtime.machine.config
        && lookup.runtime.snapshot?.machine.id === runtime.snapshot?.machine.id) return lookup.promise
      const attempt = ++generation
      callbacks.notice({ state: "loading", message: "Finding the linked native Session…" })
      const promise = discoverAgentNativeSessions(runtime.machine.config, agent, callbacks.client)
        .then((records) => {
          if (settled || generation !== attempt) return
          const matches = records.filter((record) => record.agentId === parsed.request.agentID && record.session.id === parsed.request.sessionID)
          if (matches.length !== 1) {
            throw new Error(matches.length
              ? `Session link "${parsed.request.sessionID}" is ambiguous on "${runtime.machine.name}".`
              : `Native Session "${parsed.request.sessionID}" was not found for "${agent.label}" on "${runtime.machine.name}".`)
          }
          const target = nativeSessionSurfaceTarget(runtime.snapshot!.machine.id, runtime.machine.config, matches[0])
          finish()
          callbacks.notice(null)
          callbacks.open(target)
        })
        .catch((reason: unknown) => {
          if (settled || generation !== attempt) return
          fail(`Could not open Session link: ${reason instanceof Error ? reason.message : String(reason)}`)
        })
      lookup = { runtime, promise }
      return promise
    },
    cancel() {
      if (!settled) finish()
      callbacks.notice(null)
    },
    dispose() {
      // React's StrictMode cleanup must cancel the read without consuming the next mount's URL.
      settled = true
    }
  }
}
