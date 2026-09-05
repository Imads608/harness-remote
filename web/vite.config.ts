import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

function deploymentBasePath(value: string | undefined): string {
  const path = value?.trim() || "/"
  if (!path.startsWith("/") || path.startsWith("//") || /[\\?#\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("HARNESS_REMOTE_BASE_PATH must be an absolute URL path")
  }
  return path.endsWith("/") ? path : `${path}/`
}

export default defineConfig({
  base: deploymentBasePath(process.env.HARNESS_REMOTE_BASE_PATH),
  plugins: [react()]
})
