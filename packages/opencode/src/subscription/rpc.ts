import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { subscriptionEnvironment } from "./types"

/** Owned stdio JSON-RPC boundary. No global shell changes or credential reads. */
export class RuntimeRPC {
  private child: ChildProcessWithoutNullStreams
  private sequence = 0
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private stopped = false
  onNotification: (method: string, params: any) => void = () => {}
  onRequest: (method: string, params: any) => Promise<unknown> = async () => {
    throw new Error("Unsupported runtime request")
  }
  onExit: (error: Error) => void = () => {}

  constructor(executable: string, args: string[], cwd: string) {
    this.child = spawn(executable, args, { cwd, env: subscriptionEnvironment(), stdio: ["pipe", "pipe", "pipe"] })
    // Runtime stderr may contain user content. Drain it without logging.
    this.child.stderr.resume()
    this.child.on("error", (e) => this.fail(e))
    this.child.stdin.on("error", (e) => this.fail(e))
    this.child.on("exit", () =>
      this.fail(new Error("The local runtime disconnected. Your saved conversation is preserved.")),
    )
    const lines = createInterface({ input: this.child.stdout })
    lines.on("line", (line) => {
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        this.fail(new Error("Invalid runtime protocol response"))
        return
      }
      if (message.method && message.id !== undefined) {
        void this.onRequest(message.method, message.params).then(
          (result) => this.write({ id: message.id, result }),
          () => this.write({ id: message.id, error: { code: -32603, message: "Request declined by GPD" } }),
        )
        return
      }
      if (message.method) {
        this.onNotification(message.method, message.params)
        return
      }
      const entry = this.pending.get(message.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(String(message.error.message ?? "Runtime request failed")))
      else entry.resolve(message.result)
    })
  }
  private write(value: unknown) {
    if (!this.stopped) this.child.stdin.write(JSON.stringify(value) + "\n")
  }
  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    if (this.stopped) return Promise.reject(new Error("Runtime is closed"))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Runtime timed out: ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }
  notify(method: string, params?: unknown) {
    this.write({ method, params })
  }
  private fail(error: Error) {
    if (this.stopped) return
    this.stopped = true
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    this.child.kill()
    this.onExit(error)
  }
  close() {
    this.fail(new Error("Runtime closed"))
  }
}
