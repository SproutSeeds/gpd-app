import { spawn } from "node:child_process"
import os from "node:os"
import { codexConnection, openCodex } from "./codex"
import { claudeConnection } from "./claude"
import { subscriptionEnvironment, type Connection, type RuntimeID } from "./types"
import type { RuntimeRPC } from "./rpc"

let cached: { at: number; value: Promise<Connection[]> } | undefined
export function connections(refresh = false) {
  if (!refresh && cached && Date.now() - cached.at < 30_000) return cached.value
  const value = Promise.all([codexConnection(), claudeConnection()])
  cached = { at: Date.now(), value }
  return value
}

type Login = { status: "pending" | "complete" | "failed"; url?: string; message?: string; cancel: () => void }
const logins = new Map<RuntimeID, Login>()
export function loginState(id: RuntimeID) {
  const login = logins.get(id)
  return login ? { status: login.status, url: login.url, message: login.message } : { status: "idle" }
}
export function cancelLogin(id: RuntimeID) {
  logins.get(id)?.cancel()
  logins.delete(id)
}

export async function startLogin(id: RuntimeID) {
  cancelLogin(id)
  cached = undefined
  let rpc: RuntimeRPC | undefined
  let child: ReturnType<typeof spawn> | undefined
  const timer = setTimeout(() => {
    state.status = "failed"
    state.message = "Sign in timed out. Try again."
    state.cancel()
  }, 5 * 60_000)
  const state: Login = {
    status: "pending",
    cancel() {
      clearTimeout(timer)
      rpc?.close()
      child?.kill()
    },
  }
  const complete = (ok: boolean) => {
    state.status = ok ? "complete" : "failed"
    cached = undefined
    state.cancel()
  }
  logins.set(id, state)
  try {
    if (id === "codex-subscription") {
      rpc = await openCodex()
      rpc.onNotification = (method, params) => {
        if (method === "account/login/completed") complete(params.success === true)
      }
      const response = await rpc.request("account/login/start", { type: "chatgpt" })
      state.url = response.authUrl
    } else {
      const executable = Bun.which("claude")
      if (!executable) throw new Error("Install Claude Code first.")
      child = spawn(executable, ["auth", "login", "--claudeai"], {
        cwd: os.tmpdir(),
        env: subscriptionEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      })
      let buffer = ""
      const output = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString()).slice(-16_384)
        const match = buffer.match(
          /https:\/\/(?:claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/[^\s\u001b]+/,
        )
        if (match) state.url = match[0]
      }
      child.stdout?.on("data", output)
      child.stderr?.on("data", output)
      child.on("error", () => complete(false))
      child.on("exit", (code) => {
        if (state.status === "pending") complete(code === 0)
      })
    }
  } catch (error) {
    state.message = (error as Error).message
    complete(false)
  }
  return loginState(id)
}
