import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4173
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const AUTH_USER = "harness"
const AUTH_PASSWORD = "testpw"

const agentDefinitions = [
  ["opencode", "OpenCode", "http"],
  ["omp", "Oh My Pi", "acp"],
  ["pi", "PI", "acp"],
  ["codex", "Codex CLI", "acp"],
  ["copilot", "GitHub Copilot CLI", "acp"],
  ["claude", "Claude Code", "acp"]
]

function agents() {
  return agentDefinitions.map(([id, label, transport], index) => ({
    id,
    label,
    backend: id,
    transport,
    managed: true,
    state: index % 2 === 0 ? "available" : "configured",
    capabilities: {
      sessions: true,
      prompt: true,
      abort: true,
      streaming: true,
      models: true,
      filesystemBrowser: true,
      commands: true
    }
  }))
}

const now = new Date().toISOString()
const fixtures = [
  {
    id: "machine-windows-ui",
    name: "Windows Test",
    port: 4401,
    project: { id: "project-windows", machineId: "machine-windows-ui", name: "alpha-win", path: "C:\\work\\alpha-win", kind: "git", configured: true },
    conversation: {
      id: "conversation-windows",
      machineId: "machine-windows-ui",
      projectId: "project-windows",
      project: { name: "alpha-win", path: "C:\\work\\alpha-win", kind: "git" },
      title: "Windows conversation",
      agentId: "pi",
      prompt: "Check the Windows project",
      model: null,
      status: "completed",
      workspace: { mode: "project", path: "C:\\work\\alpha-win" },
      run: null,
      runs: [],
      error: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now
    }
  },
  {
    id: "machine-linux-ui",
    name: "Linux Test",
    port: 4402,
    project: { id: "project-linux", machineId: "machine-linux-ui", name: "beta-linux", path: "/work/beta-linux", kind: "git", configured: true },
    conversation: {
      id: "conversation-linux",
      machineId: "machine-linux-ui",
      projectId: "project-linux",
      project: { name: "beta-linux", path: "/work/beta-linux", kind: "git" },
      title: "Linux conversation",
      agentId: "codex",
      prompt: "Check the Linux project",
      model: null,
      status: "completed",
      workspace: { mode: "project", path: "/work/beta-linux" },
      run: null,
      runs: [],
      error: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now
    }
  }
]

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Max-Age": "600"
  }
}

function writeJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", ...corsHeaders() })
  response.end(JSON.stringify(body))
}

function startFakeDaemon(fixture) {
  const server = http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders())
      response.end()
      return
    }

    const url = new URL(request.url || "/", `http://127.0.0.1:${fixture.port}`)
    if (url.pathname === "/v1/machine" && request.method === "GET") {
      writeJson(response, 200, { machine: { id: fixture.id, name: fixture.name, createdAt: now }, agents: agents() })
      return
    }
    if (url.pathname === "/v1/projects" && request.method === "GET") {
      writeJson(response, 200, { projects: [fixture.project] })
      return
    }
    if ((url.pathname === "/v1/work-threads" || url.pathname === "/v1/tasks") && request.method === "GET") {
      writeJson(response, 200, url.pathname === "/v1/work-threads"
        ? { workThreads: [fixture.conversation] }
        : { tasks: [fixture.conversation] })
      return
    }
    if (url.pathname === `/v1/work-threads/${fixture.conversation.id}` && request.method === "GET") {
      writeJson(response, 200, fixture.conversation)
      return
    }
    const modelMatch = /^\/v1\/agents\/([^/]+)\/models$/.exec(url.pathname)
    if (modelMatch && request.method === "GET") {
      const id = decodeURIComponent(modelMatch[1])
      const definition = agentDefinitions.find(([agentID]) => agentID === id)
      const label = definition?.[1] || id
      writeJson(response, 200, {
        models: [{
          providerID: id,
          providerName: label,
          modelID: `${id}-model`,
          modelName: `${label} Model`,
          isDefault: true,
          contextLimit: 128000
        }],
        stale: false,
        refreshedAt: now
      })
      return
    }

    writeJson(response, 404, { error: `No fake route for ${request.method} ${url.pathname}` })
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(fixture.port, "127.0.0.1", () => resolve(server))
  })
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw lastError || new Error(`Timed out waiting for ${url}`)
}

function startPreview() {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm"
  const child = spawn(executable, ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(PREVIEW_PORT), "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  child.once("exit", (code) => {
    if (code && code !== 0) process.stderr.write(`vite preview exited ${code}\n${output}\n`)
  })
  return child
}

function stopPreview(child) {
  if (!child || child.killed || !child.pid) return
  try {
    if (process.platform === "win32") child.kill("SIGTERM")
    else process.kill(-child.pid, "SIGTERM")
  } catch {
    try { child.kill("SIGTERM") } catch {}
  }
}

function stopServer(server) {
  try { server.closeAllConnections?.() } catch {}
  try { server.close() } catch {}
}

async function boundingBoxInside(page, selector, label = selector) {
  const locator = page.locator(selector).first()
  await locator.waitFor({ state: "visible" })
  const box = await locator.boundingBox()
  assert.ok(box, `${label} has no bounding box`)
  const viewport = page.viewportSize()
  assert.ok(viewport, "viewport unavailable")
  assert.ok(box.x >= -1, `${label} starts left of viewport: ${box.x}`)
  assert.ok(box.y >= -1, `${label} starts above viewport: ${box.y}`)
  assert.ok(box.x + box.width <= viewport.width + 1, `${label} is clipped horizontally: ${box.x + box.width} > ${viewport.width}`)
  assert.ok(box.y + box.height <= viewport.height + 1, `${label} is clipped vertically: ${box.y + box.height} > ${viewport.height}`)
}

async function waitForDrawerSettled(page, selector) {
  await page.waitForFunction((target) => {
    const element = document.querySelector(target)
    if (!element) return false
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return box.x >= -1 && Number(style.opacity) >= 0.999 && style.visibility === "visible"
  }, selector)
}

async function assertNoDocumentOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth
  }))
  assert.ok(metrics.scrollWidth <= metrics.width + 1, `${label}: document horizontal overflow ${metrics.scrollWidth} > ${metrics.width}`)
  assert.ok(metrics.bodyScrollWidth <= metrics.width + 1, `${label}: body horizontal overflow ${metrics.bodyScrollWidth} > ${metrics.width}`)
}

async function assertSessionFirstHome(page, mobile) {
  const sessions = page.locator('.hr-native-workspace[aria-label="Sessions"]')
  await sessions.waitFor({ state: "visible" })
  if (mobile) {
    const sessionsButton = page.locator(".hr-mobile-nav").getByRole("button", { name: /Sessions/ })
    await sessionsButton.waitFor({ state: "visible" })
    assert.equal(await sessionsButton.getAttribute("aria-current"), "page", "Sessions must be the mobile product entry")
  } else {
    await sessions.getByText("Sessions", { exact: true }).first().waitFor({ state: "visible" })
  }
  await assertNoDocumentOverflow(page, mobile ? "Session-first mobile home" : "Session-first desktop home")
}

async function assertMobileHome(page, label) {
  assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, `${label}: expected coarse pointer`)
  await assertSessionFirstHome(page, true)
  await page.locator(".hr-mobile-nav").waitFor({ state: "visible" })
  await page.locator(".hr-native-machine-group", { hasText: "Windows Test" }).waitFor({ state: "visible" })
  await page.locator(".hr-native-machine-group", { hasText: "Linux Test" }).waitFor({ state: "visible" })
  assert.equal(await page.locator(".hr-native-machine-group").count(), 2, `${label}: every configured machine must be visible`)
  await boundingBoxInside(page, ".tdw-topbar", `${label} topbar`)
  await boundingBoxInside(page, ".hr-native-workspace-list", `${label} Session list`)
  await boundingBoxInside(page, ".hr-mobile-nav", `${label} bottom navigation`)
  await assertNoDocumentOverflow(page, label)
}
async function assertStartupFeedback(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.route(/http:\/\/127\.0\.0\.1:440[12]\/v1\/machine/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    await route.continue()
  })
  await page.addInitScript(({ key, fixtures, user, password }) => {
    localStorage.setItem(key, JSON.stringify(fixtures.map((fixture) => ({
      id: fixture.id,
      name: fixture.name,
      config: { backend: "opencode", host: "127.0.0.1", port: fixture.port, username: user, password }
    }))))
  }, { key: STORAGE_KEY, fixtures, user: AUTH_USER, password: AUTH_PASSWORD })
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })
  const startup = page.getByRole("status")
  await startup.getByText("Connecting to your machines…", { exact: true }).waitFor({ state: "visible" })
  await startup.getByText(/Discovering Projects, installed coding agents and native Sessions/).waitFor({ state: "visible" })
  await assertNoDocumentOverflow(page, "startup feedback")
  await page.waitForLoadState("networkidle")
  await context.close()
}


async function runMobileAudit(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1
  })
  const page = await context.newPage()
  await page.addInitScript(({ key, fixtures, user, password }) => {
    const machines = fixtures.map((fixture) => ({
      id: fixture.id,
      name: fixture.name,
      config: { backend: "opencode", host: "127.0.0.1", port: fixture.port, username: user, password }
    }))
    localStorage.setItem(key, JSON.stringify(machines))
  }, { key: STORAGE_KEY, fixtures, user: AUTH_USER, password: AUTH_PASSWORD })

  await page.goto(APP_ORIGIN, { waitUntil: "networkidle" })
  await assertMobileHome(page, "portrait")

  await page.locator(".hr-mobile-nav").getByRole("button", { name: /Settings/ }).click()
  const settings = page.locator(".hr-session-settings-page")
  await settings.waitFor({ state: "visible" })
  assert.equal(await settings.locator("select").nth(0).locator("option").count(), 3, "portrait Settings theme choices regressed")
  assert.ok(await settings.locator("select").nth(1).locator("option").count() >= 4, "portrait Settings language choices regressed")
  await boundingBoxInside(page, ".hr-session-settings-page", "portrait Settings page")
  await assertNoDocumentOverflow(page, "portrait Settings page")
  await page.locator(".hr-mobile-nav").getByRole("button", { name: /Sessions/ }).click()
  await settings.waitFor({ state: "hidden" })

  await page.setViewportSize({ width: 844, height: 390 })
  await page.waitForTimeout(150)
  await assertMobileHome(page, "landscape")

  await page.locator(".hr-mobile-nav").getByRole("button", { name: /Machines/ }).click()
  await page.locator(".uw-machine-manager").waitFor({ state: "visible" })
  await page.getByText("Windows Test", { exact: true }).first().waitFor({ state: "visible" })
  await page.getByText("Linux Test", { exact: true }).first().waitFor({ state: "visible" })
  await boundingBoxInside(page, ".uw-machine-manager", "landscape Machines page")
  await assertNoDocumentOverflow(page, "landscape Machines page")
  await context.close()
}

async function runDesktopAudit(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.addInitScript(({ key, fixtures, user, password }) => {
    localStorage.setItem(key, JSON.stringify(fixtures.map((fixture) => ({
      id: fixture.id,
      name: fixture.name,
      config: { backend: "opencode", host: "127.0.0.1", port: fixture.port, username: user, password }
    }))))
  }, { key: STORAGE_KEY, fixtures, user: AUTH_USER, password: AUTH_PASSWORD })
  await page.goto(APP_ORIGIN, { waitUntil: "networkidle" })
  await assertSessionFirstHome(page, false)
  await page.locator(".hr-native-machine-group", { hasText: "Windows Test" }).waitFor({ state: "visible" })
  await page.locator(".hr-native-machine-group", { hasText: "Linux Test" }).waitFor({ state: "visible" })
  assert.equal(await page.locator(".hr-native-machine-group").count(), 2, "desktop: every configured machine must be visible")
  await boundingBoxInside(page, ".tdw-topbar", "desktop topbar")
  await boundingBoxInside(page, ".hr-native-workspace-list", "desktop Session list")
  await boundingBoxInside(page, ".hr-native-workspace-detail", "desktop main")
  await page.getByText("2/2 machines", { exact: true }).waitFor({ state: "visible" })
  await assertNoDocumentOverflow(page, "desktop initial")

  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".hr-session-settings-page")
  await settings.waitFor({ state: "visible" })
  await boundingBoxInside(page, ".hr-session-settings-page", "desktop Settings")
  assert.equal(await settings.locator("select").nth(0).locator("option").count(), 3, "desktop Settings theme choices regressed")
  assert.ok(await settings.locator("select").nth(1).locator("option").count() >= 4, "desktop Settings language choices regressed")
  await settings.locator("header button").click()
  await settings.waitFor({ state: "hidden" })

  await page.getByRole("button", { name: /Machines/ }).click()
  await page.locator(".uw-machine-manager").waitFor({ state: "visible" })
  await boundingBoxInside(page, ".uw-machine-manager", "desktop Machines")
  await assertNoDocumentOverflow(page, "desktop Machines")
  await page.locator(".uw-manager-close").click()

  const overlap = await page.evaluate(() => {
    const context = document.querySelector(".tdw-context-path")?.getBoundingClientRect()
    const actions = document.querySelector(".tdw-top-actions")?.getBoundingClientRect()
    if (!context || !actions) return null
    return { contextRight: context.right, actionsLeft: actions.left }
  })
  assert.ok(overlap, "desktop topbar regions not found")
  assert.ok(overlap.contextRight <= overlap.actionsLeft + 1, `desktop topbar overlap: context right ${overlap.contextRight}, actions left ${overlap.actionsLeft}`)
  await context.close()
}

const servers = []
let preview
let browser
try {
  for (const fixture of fixtures) servers.push(await startFakeDaemon(fixture))
  preview = startPreview()
  await waitForHttp(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  await assertStartupFeedback(browser)
  console.log("v3 browser smoke: startup feedback passed")
  console.log("v3 browser smoke: mobile audit start")
  await runMobileAudit(browser)
  console.log("v3 browser smoke: mobile audit passed")
  await runDesktopAudit(browser)
  console.log("v3 browser smoke: desktop audit passed")
  console.log("v3 browser smoke: Session-first startup, portrait, landscape, multi-machine, Settings and desktop geometry passed")
} finally {
  if (browser) await browser.close().catch(() => {})
  stopPreview(preview)
  for (const server of servers) stopServer(server)
}
