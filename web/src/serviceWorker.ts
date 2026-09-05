const CACHE_PREFIX = "harness-remote-"
const RELOAD_MARKER_PREFIX = "harness-remote.gateway-sw-reload:"

export type GatewayServiceWorkerResult = "ready" | "reloading" | "blocked"

function sameScript(left: string | undefined, right: string): boolean {
  if (!left) return false
  try {
    const candidate = new URL(left)
    const expected = new URL(right)
    return candidate.origin === expected.origin && candidate.pathname === expected.pathname
  } catch {
    return false
  }
}

/**
 * A previously installed standalone worker can keep controlling the current document after it is
 * unregistered. Clear its caches and reload once before the gateway app is allowed to make any
 * authenticated requests; if it still controls the reloaded page, fail closed instead of rendering.
 */
export async function disableGatewayServiceWorker(basePath: string): Promise<GatewayServiceWorkerResult> {
  const scope = new URL(basePath, window.location.href).href
  const scriptURL = new URL("sw.js", scope).href
  const registrations = await navigator.serviceWorker.getRegistrations()
  const exactRegistrations = registrations.filter((registration) => registration.scope === scope)
  const controlled = sameScript(navigator.serviceWorker.controller?.scriptURL, scriptURL)

  const removed = await Promise.all(exactRegistrations.map((registration) => registration.unregister()))
  if (removed.some((result) => !result)) return "blocked"

  if ("caches" in window) {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => caches.delete(key)))
  }

  const reloadMarker = `${RELOAD_MARKER_PREFIX}${scope}`
  if (controlled) {
    try {
      if (sessionStorage.getItem(reloadMarker) === "1") return "blocked"
      sessionStorage.setItem(reloadMarker, "1")
    } catch {
      return "blocked"
    }
    window.location.reload()
    return "reloading"
  }

  try { sessionStorage.removeItem(reloadMarker) } catch {}
  return "ready"
}
