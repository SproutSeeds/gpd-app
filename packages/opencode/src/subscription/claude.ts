import { createHash } from "node:crypto"
import os from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { query, type Query, type SDKUserMessage, type Options } from "@anthropic-ai/claude-agent-sdk"
import { claudeReadiness, subscriptionEnvironment, type Connection, type ResearchInput } from "./types"
import { subscriptionAccess } from "./access"

function inbox() {
  const messages: SDKUserMessage[] = []
  let wake: (() => void) | undefined
  let closed = false
  return {
    push(message: SDKUserMessage) {
      messages.push(message)
      wake?.()
    },
    close() {
      closed = true
      wake?.()
    },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (!messages.length)
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        while (messages.length) yield messages.shift()!
      }
    },
  }
}

function options(cwd: string): Options {
  const executable = Bun.which("claude")
  if (!executable) throw new Error("Install Claude Code to connect your Claude subscription.")
  return {
    cwd,
    pathToClaudeCodeExecutable: executable,
    env: subscriptionEnvironment(),
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    permissionMode: "default",
    settings: { disableAllHooks: true, fastMode: false },
    persistSession: false,
    stderr: () => {},
    promptSuggestions: false,
  }
}

export async function readClaudeAuthStatus(
  run: () => Promise<{ stdout: string }> = () =>
    promisify(execFile)(Bun.which("claude")!, ["auth", "status", "--json"], {
      env: subscriptionEnvironment(),
      timeout: 15_000,
    }),
) {
  let stdout: string
  try {
    stdout = (await run()).stdout
  } catch (error) {
    // Claude exits 1 with valid JSON when signed out. Other failures must not
    // masquerade as a disconnected account or expose raw command output.
    const failure = error as { code?: unknown; stdout?: unknown }
    if (failure.code === 1 && typeof failure.stdout === "string") {
      try {
        const value = JSON.parse(failure.stdout)
        if (value.loggedIn === false) return value
      } catch {}
    }
    throw new Error("Claude Code could not check your sign in. Try Refresh connections.")
  }
  try {
    const value = JSON.parse(stdout)
    if (typeof value.loggedIn === "boolean") return value
  } catch {}
  throw new Error("Claude Code returned an unreadable sign in status. Try Refresh connections.")
}

async function inspect(session: Query, readAuth = readClaudeAuthStatus) {
  const login = await readAuth()
  const account = await session.accountInfo()
  if (
    login.loggedIn !== true ||
    login.authMethod !== "claude.ai" ||
    login.apiProvider !== "firstParty" ||
    account.apiProvider !== "firstParty" ||
    !account.subscriptionType ||
    (account.apiKeySource && account.apiKeySource !== "none")
  )
    throw new Error("Sign in to Claude Code with your Claude subscription. API accounts are unavailable in this app.")
  const catalog = await session.supportedModels()
  // The runtime owns the catalog. Hide explicitly credit-only/context upgrade
  // entries; the independent no-overage check remains mandatory for every turn.
  const models = catalog
    .filter((x) => !/\[1m\]|usage credits|extra usage|credits required/i.test(x.value + " " + x.description))
    .map((x) => ({ id: x.value, name: x.displayName, efforts: x.supportedEffortLevels ?? [], image: true }))
  const usage = claudeReadiness(
    await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
  )
  if (!login.email) throw new Error("Claude account identity could not be verified.")
  return {
    account,
    models,
    usage,
    owner: createHash("sha256")
      .update(JSON.stringify({ email: login.email, organization: login.orgId }))
      .digest("hex"),
  }
}

export async function claudeConnection(
  drivers: { auth: typeof readClaudeAuthStatus; query: typeof query; installed?: () => boolean } = {
    auth: readClaudeAuthStatus,
    query,
  },
): Promise<Connection> {
  const base = {
    id: "claude-subscription" as const,
    name: "Claude Code",
    installed: drivers.installed?.() ?? !!Bun.which("claude"),
    checkedAt: Date.now(),
  }
  const stream = inbox()
  let session: Query | undefined
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
    session?.close()
  }, 25_000)
  try {
    if (!base.installed) throw new Error("Install Claude Code to connect your Claude subscription.")
    const login = await drivers.auth()
    if (login.loggedIn !== true) throw new Error("Sign in to Claude Code with your Claude subscription.")
    session = drivers.query({
      prompt: stream,
      options: { ...options(os.tmpdir()), tools: [], abortController: controller },
    })
    const data = await inspect(session, async () => login)
    return { ...base, authenticated: true, plan: data.account.subscriptionType, models: data.models, usage: data.usage }
  } catch (error) {
    return {
      ...base,
      authenticated: false,
      models: [],
      usage: { ready: false, reason: String((error as Error).message) },
    }
  } finally {
    clearTimeout(timeout)
    stream.close()
    session?.close()
  }
}

export function runClaude(
  input: ResearchInput,
  drivers = { query, auth: readClaudeAuthStatus },
  access = subscriptionAccess,
) {
  return access.run("claude-subscription", input.signal, (signal) => runConnectedClaude({ ...input, signal }, drivers))
}

async function runConnectedClaude(
  input: ResearchInput,
  drivers: { query: typeof query; auth: typeof readClaudeAuthStatus },
) {
  const stream = inbox()
  const controller = new AbortController()
  let session: Query | undefined
  const abort = () => {
    controller.abort(input.signal.reason)
    session?.close()
  }
  input.signal.addEventListener("abort", abort, { once: true })
  try {
    input.signal.throwIfAborted()
    session = drivers.query({
      prompt: stream,
      options: {
        ...options(input.cwd),
        model: input.model,
        effort: input.effort as Options["effort"],
        resume: input.nativeID,
        permissionMode: input.readOnly ? "plan" : "default",
        persistSession: true,
        includePartialMessages: true,
        abortController: controller,
        mcpServers: input.readOnly
          ? {}
          : Object.fromEntries(
              Object.entries(input.mcp).map(([key, value]) => [key, { type: "stdio" as const, ...value }]),
            ),
        systemPrompt: input.instructions
          ? { type: "preset", preset: "claude_code", append: input.instructions }
          : { type: "preset", preset: "claude_code" },
        canUseTool: async (name, toolInput, context) => {
          if (name === "AskUserQuestion" && Array.isArray(toolInput.questions)) {
            const questions = toolInput.questions as {
              header: string
              question: string
              options: { label: string; description: string }[]
            }[]
            const answers = await input.question(questions)
            return {
              behavior: "allow",
              updatedInput: {
                ...toolInput,
                answers: Object.fromEntries(questions.map((q, i) => [q.question, answers[i]?.join(", ") ?? ""])),
              },
            }
          }
          if (await input.approve(name, toolInput, context.toolUseID))
            return { behavior: "allow", updatedInput: toolInput }
          return { behavior: "deny", message: "The user declined this action." }
        },
      },
    })
    const status = await inspect(session, drivers.auth)
    if (!status.usage.ready) throw new Error(status.usage.reason)
    if (!status.models.some((x) => x.id === input.model))
      throw new Error("This model is no longer available. Refresh your connection.")
    if (input.nativeID && input.nativeOwner !== status.owner)
      throw new Error("This conversation belongs to a different Claude account. Start a new conversation.")
    input.signal.throwIfAborted()
    const content: any[] = [{ type: "text", text: input.text }]
    for (const url of input.images) {
      const match = /^data:(image\/[^;]+);base64,(.*)$/s.exec(url)
      if (!match) throw new Error("Claude image attachments must be local image data.")
      content.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } })
    }
    stream.push({
      type: "user",
      session_id: input.nativeID ?? "",
      parent_tool_use_id: null,
      message: { role: "user", content },
    })
    const tools = new Map<string, { name: string; input: Record<string, unknown> }>()
    let current = ""
    let complete = false
    let sawText = false
    for await (const event of session) {
      // Nested agents report through their parent tool result. Keeping their
      // partial deltas out of this stream prevents interleaved text corruption.
      if ("parent_tool_use_id" in event && event.parent_tool_use_id) continue
      if (event.type === "system" && event.subtype === "init") await input.native(event.session_id, status.owner)
      if (event.type === "stream_event") {
        const part = event.event
        if (part.type === "message_start") current = part.message.id
        if (part.type === "content_block_delta" && part.delta.type === "text_delta") {
          sawText = true
          await input.emit({ type: "text", id: `${current}:${part.index}`, text: part.delta.text })
        }
        if (part.type === "content_block_delta" && part.delta.type === "thinking_delta")
          await input.emit({ type: "reasoning", id: `${current}:thinking:${part.index}`, text: part.delta.thinking })
      }
      if (event.type === "assistant") {
        if (event.error) throw new Error(`Claude stopped: ${event.error}`)
        for (const part of event.message.content) {
          if (part.type !== "tool_use") continue
          const entry = { name: part.name, input: part.input as Record<string, unknown> }
          tools.set(part.id, entry)
          await input.emit({ type: "tool", id: part.id, ...entry, done: false })
        }
      }
      if (event.type === "user" && Array.isArray(event.message.content)) {
        for (const part of event.message.content) {
          if (part.type !== "tool_result") continue
          const entry = tools.get(part.tool_use_id)
          if (!entry) continue
          const output = typeof part.content === "string" ? part.content : JSON.stringify(part.content)
          await input.emit({
            type: "tool",
            id: part.tool_use_id,
            ...entry,
            done: true,
            output,
            error: part.is_error ? output : undefined,
          })
        }
      }
      if (event.type === "rate_limit_event") {
        const limit = event.rate_limit_info
        if (limit.status === "rejected" || limit.isUsingOverage || limit.overageInUse)
          throw new Error("Claude reached its included usage limit. Research stopped.")
      }
      if (event.type === "result") {
        if (event.is_error) throw new Error("errors" in event ? event.errors.join("\n") : "Claude research failed.")
        if (!sawText && "result" in event && event.result)
          await input.emit({ type: "text", id: "result", text: event.result })
        await input.emit({
          type: "usage",
          input: event.usage.input_tokens,
          output: event.usage.output_tokens,
          reasoning: 0,
          cacheRead: event.usage.cache_read_input_tokens ?? 0,
          cacheWrite: event.usage.cache_creation_input_tokens ?? 0,
        })
        complete = true
        break
      }
    }
    if (!complete) throw new Error("Claude disconnected before completing the turn. Your conversation is preserved.")
  } finally {
    stream.close()
    controller.abort()
    session?.close()
    input.signal.removeEventListener("abort", abort)
  }
}
