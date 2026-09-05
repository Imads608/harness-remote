import { normalizeServerConfig } from "./serverConfig"
import type { ServerConfig } from "./types"

export const WORKSPACE_MACHINES_STORAGE_KEY = "harness-remote.workspace.machines.v1"

export type WorkspaceMachine = {
  id: string
  name: string
  config: ServerConfig
  /** Provisioned by the authenticated web gateway rather than owned by local browser storage. */
  provisioned?: boolean
}

export type ProvisionedWorkspaceMachine = {
  id: string
  name: string
  proxyPath: string
}

declare global {
  interface Window {
    readonly HARNESS_REMOTE_GATEWAY_MODE?: boolean
    readonly HARNESS_REMOTE_PROVISIONED_MACHINES?: readonly ProvisionedWorkspaceMachine[]
  }
}

function machineID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `machine-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalizeMachine(value: unknown, provisioned = false): WorkspaceMachine | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as {
    id?: unknown
    name?: unknown
    config?: Partial<ServerConfig>
  }
  const config = candidate.config
  if (!config || typeof config.host !== "string" || typeof config.port !== "number") return null
  if (typeof config.username !== "string" || typeof config.password !== "string") return null
  const normalized = normalizeServerConfig({
    backend: "opencode",
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    proxyPath: config.proxyPath
  })
  if (!normalized) return null

  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : machineID(),
    name: typeof candidate.name === "string" && candidate.name.trim()
      ? candidate.name.trim()
      : normalized.host,
    config: {
      ...normalized,
      backend: "opencode",
      agentId: undefined
    },
    ...(provisioned ? { provisioned: true } : {})
  }
}

function provisionedWorkspaceMachines(): WorkspaceMachine[] {
  if (typeof window === "undefined") return []
  const { protocol, hostname, port: locationPort } = window.location
  if ((protocol !== "http:" && protocol !== "https:") || !hostname) return []
  const port = locationPort ? Number(locationPort) : protocol === "https:" ? 443 : 80
  const source = window.HARNESS_REMOTE_PROVISIONED_MACHINES
  if (!Array.isArray(source)) return []

  return source.flatMap((value) => {
    if (!value || typeof value !== "object") return []
    const candidate = value as Partial<ProvisionedWorkspaceMachine>
    if (
      typeof candidate.id !== "string"
      || typeof candidate.name !== "string"
      || typeof candidate.proxyPath !== "string"
    ) return []
    const machine = normalizeMachine({
      id: candidate.id,
      name: candidate.name,
      config: {
        backend: "opencode",
        host: `${protocol}//${hostname}`,
        port,
        username: "",
        password: "",
        proxyPath: candidate.proxyPath
      }
    }, true)
    return machine ? [machine] : []
  })
}

export function isGatewayDeployment(): boolean {
  return typeof window !== "undefined" && (
    window.HARNESS_REMOTE_GATEWAY_MODE === true
    || (Array.isArray(window.HARNESS_REMOTE_PROVISIONED_MACHINES) && window.HARNESS_REMOTE_PROVISIONED_MACHINES.length > 0)
  )
}

function dedupeMachines(machines: WorkspaceMachine[]): WorkspaceMachine[] {
  const seen = new Set<string>()
  return machines.filter((machine) => {
    if (seen.has(machine.id)) return false
    seen.add(machine.id)
    return true
  })
}

export function loadWorkspaceMachines(): WorkspaceMachine[] {
  const provisioned = dedupeMachines(provisionedWorkspaceMachines())
  let saved: WorkspaceMachine[] = []
  try {
    const raw = localStorage.getItem(WORKSPACE_MACHINES_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        saved = parsed.flatMap((value) => {
          const machine = normalizeMachine(value)
          return machine ? [machine] : []
        })
      }
    }
  } catch {
    // Provisioned machines remain usable when browser storage is unavailable or malformed.
  }
  return dedupeMachines([...provisioned, ...saved])
}

export function persistWorkspaceMachines(machines: WorkspaceMachine[]): void {
  const provisionedIDs = new Set(provisionedWorkspaceMachines().map((machine) => machine.id))
  const normalized = machines.flatMap((machine) => {
    if (machine.provisioned || provisionedIDs.has(machine.id)) return []
    const next = normalizeMachine(machine)
    return next ? [next] : []
  })
  localStorage.setItem(WORKSPACE_MACHINES_STORAGE_KEY, JSON.stringify(normalized))
}

export function createWorkspaceMachine(): WorkspaceMachine {
  return {
    id: machineID(),
    name: "New machine",
    config: {
      backend: "opencode",
      host: "",
      port: 4097,
      username: "harness",
      password: ""
    }
  }
}
