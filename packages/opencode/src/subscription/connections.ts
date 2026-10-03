import { spawn } from "node:child_process"
import os from "node:os"
import { codexConnection, openCodex } from "./codex"
import { claudeConnection } from "./claude"
import { runtimeIDs, subscriptionEnvironment, type Connection, type RuntimeID } from "./types"
import { subscriptionAccess } from "./access"
import type { RuntimeRPC } from "./rpc"

type Login = { status: "pending" | "complete" | "failed"; url?: string; message?: string; cancel: () => void }

export function createConnections(
  probes: Record<RuntimeID, () => Promise<Connection>> = {
    "codex-subscription": codexConnection,
    "claude-subscription": claudeConnection,
  },
  access = subscriptionAccess,
) {
  let cached: { at: number; value: Promise<Connection[]> } | undefined
  const logins = new Map<RuntimeID, Login>()
  function disconnected(id: RuntimeID): Connection {
    return {
      id,
      name: id === "codex-subscription" ? "Codex" : "Claude Code",
      installed: !!Bun.which(id === "codex-subscription" ? "codex" : "claude"),
      enabled: false,
      authenticated: false,
      models: [],
      checkedAt: Date.now(),
      usage: {
        ready: false,
        reason: "Disconnected from GPD. Your conversations and sign in in other apps are preserved.",
      },
    }
  }
  async function inspect(id: RuntimeID) {
    if (!(await access.enabled(id))) return disconnected(id)
    const connection = await probes[id]()
    return (await access.enabled(id)) ? { ...connection, enabled: true } : disconnected(id)
  }
  async function connections(refresh = false) {
    if (refresh || !cached || Date.now() - cached.at >= 30_000)
      cached = { at: Date.now(), value: Promise.all(runtimeIDs.map(inspect)) }
    // Reapply local access even to an in-flight cached status request. A stale
    // model catalog must never make a disconnected provider available again.
    return Promise.all(
      (await cached.value).map(async (connection) =>
        (await access.enabled(connection.id)) ? connection : disconnected(connection.id),
      ),
    )
  }
  function loginState(id: RuntimeID) {
    const login = logins.get(id)
    return login ? { status: login.status, url: login.url, message: login.message } : { status: "idle" }
  }
  function cancelLogin(id: RuntimeID) {
    logins.get(id)?.cancel()
    logins.delete(id)
  }
  async function disconnect(id: RuntimeID) {
    cancelLogin(id)
    cached = undefined
    await access.setEnabled(id, false)
  }

  async function startLogin(id: RuntimeID) {
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
      if (logins.get(id) !== state || state.status !== "pending") return
      state.status = ok ? "complete" : "failed"
      cached = undefined
      state.cancel()
    }
    logins.set(id, state)
    try {
      await access.setEnabled(id, true)
      if (logins.get(id) !== state || state.status !== "pending") return loginState(id)
      // Reconnect the existing runtime account without logging out or starting
      // another browser flow. Included usage is still checked before research.
      const connection = await inspect(id)
      const enabled = await access.enabled(id)
      if (!enabled || logins.get(id) !== state || state.status !== "pending") return loginState(id)
      if (connection.authenticated) {
        complete(true)
        return loginState(id)
      }
      if (id === "codex-subscription") {
        rpc = await openCodex()
        if (logins.get(id) !== state || state.status !== "pending") {
          rpc.close()
          return loginState(id)
        }
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

  return { connections, startLogin, loginState, cancelLogin, disconnect }
}

export const { connections, startLogin, loginState, cancelLogin, disconnect } = createConnections()
