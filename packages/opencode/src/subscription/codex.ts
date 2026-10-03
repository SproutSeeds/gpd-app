import { createHash } from "node:crypto"
import os from "node:os"
import { RuntimeRPC } from "./rpc"
import { codexReadiness, type Connection, type ResearchInput, type RuntimeModel } from "./types"
import { subscriptionAccess } from "./access"

export async function openCodex(cwd = os.tmpdir()) {
  const executable = Bun.which("codex")
  if (!executable) throw new Error("Install Codex to connect your ChatGPT subscription.")
  const rpc = new RuntimeRPC(
    executable,
    ["app-server", "--listen", "stdio://", "-c", 'forced_login_method="chatgpt"'],
    cwd,
  )
  try {
    await rpc.request(
      "initialize",
      {
        clientInfo: { name: "gpd_subscription", title: "GPD", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      15_000,
    )
    rpc.notify("initialized")
    return rpc
  } catch (error) {
    rpc.close()
    throw error
  }
}

type RPC = Pick<RuntimeRPC, "request" | "notify" | "close" | "onNotification" | "onRequest" | "onExit">
async function inspect(rpc: RPC) {
  const first = await rpc.request("account/read", { refreshToken: false })
  const account = first.account
  if (account?.type !== "chatgpt")
    throw new Error("Sign in to Codex with ChatGPT. API key accounts are unavailable in this app.")
  const models: RuntimeModel[] = []
  let cursor: string | undefined
  const cursors = new Set<string>()
  do {
    const page = await rpc.request("model/list", { limit: 100, includeHidden: false, cursor })
    if (!Array.isArray(page.data)) throw new Error("Codex returned an unsupported model catalog.")
    for (const model of page.data) {
      if (model.hidden || typeof model.id !== "string") continue
      models.push({
        id: model.model ?? model.id,
        name: model.displayName ?? model.id,
        default: model.isDefault,
        efforts: (model.supportedReasoningEfforts ?? []).map((x: any) => x.reasoningEffort),
        image: model.inputModalities?.includes("image"),
      })
    }
    cursor = page.nextCursor ?? undefined
    if (cursor && cursors.has(cursor)) throw new Error("Codex repeated a model catalog page.")
    if (cursors.size >= 10) throw new Error("Codex model catalog exceeded the supported page limit.")
    if (cursor) cursors.add(cursor)
  } while (cursor)
  const quota = await rpc.request("account/rateLimits/read", {})
  const usage = codexReadiness(quota)
  const last = await rpc.request("account/read", { refreshToken: false })
  if (JSON.stringify(account) !== JSON.stringify(last.account))
    throw new Error("Codex account changed. Refresh the connection.")
  const identity = quota.accountId ?? account.email
  if (!identity) throw new Error("Codex account identity could not be verified.")
  return { account, models, usage, owner: createHash("sha256").update(identity).digest("hex") }
}

export async function codexConnection(): Promise<Connection> {
  const base = {
    id: "codex-subscription" as const,
    name: "Codex",
    installed: !!Bun.which("codex"),
    checkedAt: Date.now(),
  }
  let rpc: RuntimeRPC | undefined
  const timeout = setTimeout(() => rpc?.close(), 25_000)
  try {
    rpc = await openCodex()
    const data = await inspect(rpc)
    return { ...base, authenticated: true, plan: data.account.planType, models: data.models, usage: data.usage }
  } catch (error) {
    return {
      ...base,
      authenticated: false,
      models: [],
      usage: { ready: false, reason: String((error as Error).message) },
    }
  } finally {
    clearTimeout(timeout)
    rpc?.close()
  }
}

export function runCodex(
  input: ResearchInput,
  open: (cwd?: string) => Promise<RPC> = openCodex,
  access = subscriptionAccess,
) {
  return access.run("codex-subscription", input.signal, (signal) => runConnectedCodex({ ...input, signal }, open))
}

async function runConnectedCodex(input: ResearchInput, open: (cwd?: string) => Promise<RPC>) {
  const rpc = await open(input.cwd)
  let threadID = ""
  let turnID = ""
  let settle: (() => void) | undefined
  let reject: ((e: Error) => void) | undefined
  let queue = Promise.resolve()
  let deliveryError: Error | undefined
  const deliveryFailed = (error: Error) => {
    deliveryError = error
    reject?.(error)
  }
  const done = new Promise<void>((resolve, fail) => {
    settle = resolve
    reject = fail
  })
  // Attach a rejection handler immediately, before metadata or thread creation.
  void done.catch(() => {})
  const cancel = () => {
    if (threadID && turnID)
      void rpc.request("turn/interrupt", { threadId: threadID, turnId: turnID }, 3000).catch(() => {})
    reject?.(
      new Error(
        input.signal.reason?.message?.includes("disconnected from GPD")
          ? input.signal.reason.message
          : "Research stopped.",
      ),
    )
    rpc.close()
  }
  input.signal.addEventListener("abort", cancel, { once: true })
  try {
    input.signal.throwIfAborted()
    const status = await inspect(rpc)
    input.signal.throwIfAborted()
    if (!status.usage.ready) throw new Error(status.usage.reason)
    if (!status.models.some((x) => x.id === input.model))
      throw new Error("This model is no longer available. Refresh your connection.")
    if (input.nativeID && input.nativeOwner !== status.owner)
      throw new Error("This conversation belongs to a different Codex account. Start a new conversation.")
    const currentConfig = await rpc.request("config/read", { includeLayers: false })
    const disabledMcp = Object.fromEntries(
      [...Object.keys(currentConfig.config?.mcp_servers ?? {}), ...Object.keys(input.mcp)].map((name) => [
        name,
        { enabled: false },
      ]),
    )
    const config = {
      model_provider: "openai",
      forced_login_method: "chatgpt",
      service_tier: "default",
      mcp_servers: input.readOnly
        ? disabledMcp
        : {
            ...disabledMcp,
            ...Object.fromEntries(Object.entries(input.mcp).map(([key, value]) => [key, { ...value, enabled: true }])),
          },
    }
    const params = {
      cwd: input.cwd,
      model: input.model,
      modelProvider: "openai",
      serviceTier: "default",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: input.readOnly ? "read-only" : "workspace-write",
      config,
      developerInstructions: input.instructions ?? null,
    }
    const started = await rpc.request(
      input.nativeID ? "thread/resume" : "thread/start",
      input.nativeID ? { ...params, threadId: input.nativeID } : params,
    )
    threadID = started.thread.id
    await input.native(threadID, status.owner)
    rpc.onExit = (error) => reject?.(error)
    rpc.onRequest = async (method, p) => {
      if (p.threadId !== threadID || (turnID && p.turnId && p.turnId !== turnID) || input.signal.aborted)
        throw new Error("Unmatched request")
      if (method === "item/tool/requestUserInput") {
        const answers = await input.question(
          p.questions.map((q: any) => ({ header: q.header, question: q.question, options: q.options ?? [] })),
        )
        return {
          answers: Object.fromEntries(p.questions.map((q: any, i: number) => [q.id, { answers: answers[i] ?? [] }])),
        }
      }
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        const allowed = await input.approve(method.includes("commandExecution") ? "bash" : "edit", p, p.itemId)
        return { decision: allowed ? "accept" : "decline" }
      }
      if (method === "item/permissions/requestApproval") {
        const allowed = await input.approve("permissions", p, p.itemId)
        return { permissions: allowed ? p.permissions : {}, scope: "turn", strictAutoReview: true }
      }
      if (method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null }
      throw new Error("Unsupported runtime approval")
    }
    rpc.onNotification = (method, p) => {
      if (p.threadId && p.threadId !== threadID) return
      if (turnID && p.turnId && p.turnId !== turnID) return
      if (method === "account/updated") {
        cancel()
        return
      }
      if (method === "account/rateLimits/updated") {
        void rpc.request("account/rateLimits/read", {}).then((value) => {
          if (!codexReadiness(value).ready) cancel()
        }, cancel)
        return
      }
      if (method === "thread/tokenUsage/updated" && p.tokenUsage?.last) {
        const usage = p.tokenUsage.last
        queue = queue
          .then(() =>
            input.emit({
              type: "usage",
              input: usage.inputTokens,
              output: usage.outputTokens,
              reasoning: usage.reasoningOutputTokens,
              cacheRead: usage.cachedInputTokens,
              cacheWrite: usage.cacheWriteInputTokens ?? 0,
              total: usage.totalTokens,
            }),
          )
          .catch(deliveryFailed)
      }
      if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta") {
        queue = queue
          .then(() =>
            input.emit({ type: method.includes("reasoning") ? "reasoning" : "text", id: p.itemId, text: p.delta }),
          )
          .catch(deliveryFailed)
      }
      if (method === "item/started" || method === "item/completed") {
        const item = p.item
        if (item?.type === "agentMessage" && method === "item/completed") {
          queue = queue
            .then(() => input.emit({ type: "text", id: item.id, text: item.text, replace: true }))
            .catch(deliveryFailed)
        } else if (item && ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(item.type)) {
          queue = queue
            .then(() =>
              input.emit({
                type: "tool",
                id: item.id,
                name:
                  item.type === "commandExecution"
                    ? "bash"
                    : item.type === "fileChange"
                      ? "edit"
                      : (item.tool ?? item.type),
                input: item.arguments ?? { command: item.command, changes: item.changes, query: item.query },
                done: method === "item/completed",
                output: item.aggregatedOutput ?? (item.result ? JSON.stringify(item.result) : undefined),
                error: item.error ? JSON.stringify(item.error) : undefined,
              }),
            )
            .catch(deliveryFailed)
        }
      }
      if (method === "turn/completed") {
        if (p.turn?.status === "completed") settle?.()
        else reject?.(new Error(p.turn?.error?.message ?? "Research was interrupted."))
      }
    }
    input.signal.throwIfAborted()
    if (input.text.trim() === "/compact") {
      await rpc.request("thread/compact/start", { threadId: threadID })
      await done
      await queue
      if (deliveryError) throw deliveryError
      await input.emit({ type: "text", id: "compaction", text: "Conversation compacted by Codex." })
      return
    }
    const response = await rpc.request("turn/start", {
      threadId: threadID,
      clientUserMessageId: input.messageID,
      input: [
        { type: "text", text: input.text, text_elements: [] },
        ...input.images.map((url) => ({ type: "image", url })),
      ],
      model: input.model,
      effort: input.effort,
      serviceTier: "default",
      serviceTierForTurn: "default",
    })
    turnID = response.turn.id
    if (input.signal.aborted) cancel()
    await done
    await queue
    if (deliveryError) throw deliveryError
  } finally {
    input.signal.removeEventListener("abort", cancel)
    rpc.close()
  }
}
