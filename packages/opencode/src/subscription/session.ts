import { Effect, Context, Layer } from "effect"
import { NamedError } from "@opencode-ai/util/error"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { MessageID, PartID, SessionID } from "../session/schema"
import { Storage } from "../storage/storage"
import { Permission } from "../permission"
import { Question } from "../question"
import { Config } from "../config/config"
import { InstanceState } from "../effect/instance-state"
import { runCodex } from "./codex"
import { runClaude } from "./claude"
import { isRuntime, type RuntimeEvent } from "./types"
import { clearPendingRequests } from "./cleanup"

type Saved = { nativeID: string; owner: string; assistantID: string }

export namespace SubscriptionSession {
  export interface Interface {
    run: (input: {
      sessionID: SessionID
      user: MessageV2.User
      messages: MessageV2.WithParts[]
      instructions?: string
    }) => Effect.Effect<MessageV2.WithParts>
  }
  export class Service extends Context.Service<Service, Interface>()("@opencode/SubscriptionSession") {}
  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const permissions = yield* Permission.Service
      const questions = yield* Question.Service
      const config = yield* Config.Service

      const run = Effect.fn("SubscriptionSession.run")(function* (input: Parameters<Interface["run"]>[0]) {
        const ctx = yield* InstanceState.context
        const services = yield* Effect.context()
        const promise = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(services)(effect)
        const session = yield* sessions.get(input.sessionID)
        const cfg = yield* config.get()
        const id = input.user.model.providerID
        if (!isRuntime(id)) throw new Error("Connect a subscription runtime before starting research.")
        const key = ["subscription-session", input.sessionID, id]
        const previous = yield* storage.read<Saved>(key).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const lastAssistant = input.messages.findLast((x) => x.info.role === "assistant")
        const saved = previous?.assistantID === lastAssistant?.info.id ? previous : undefined
        const current = input.messages.find((x) => x.info.id === input.user.id)!
        const text = (message: MessageV2.WithParts) =>
          message.parts
            .flatMap((part) => {
              if (part.type === "text" && !part.ignored) return [part.text]
              if (part.type === "subtask") return [part.prompt]
              return []
            })
            .join("\n\n")
        const history = saved
          ? ""
          : input.messages
              .filter((x) => x.info.id !== input.user.id)
              .map((x) => `${x.info.role}: ${text(x)}`)
              .filter((x) => !x.endsWith(": "))
              .join("\n\n")
        const prompt = history
          ? `Conversation so far:\n${history}\n\nCurrent request:\n${text(current)}`
          : text(current)
        const mcp = Object.fromEntries(
          Object.entries(cfg.mcp ?? {}).flatMap(([name, value]) =>
            "type" in value && value.type === "local" && value.enabled !== false
              ? [[name, { command: value.command[0], args: value.command.slice(1), env: value.environment }]]
              : [],
          ),
        )
        const info: MessageV2.Assistant = {
          id: MessageID.ascending(),
          sessionID: input.sessionID,
          parentID: input.user.id,
          role: "assistant",
          agent: input.user.agent,
          mode: input.user.agent,
          modelID: input.user.model.modelID,
          providerID: id,
          path: { cwd: ctx.directory, root: ctx.worktree },
          time: { created: Date.now() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          variant: input.user.model.variant,
        }
        yield* sessions.updateMessage(info)
        const parts = new Map<string, MessageV2.Part>()
        const emit = async (event: RuntimeEvent) => {
          if (event.type === "usage") {
            info.tokens = {
              input: event.input,
              output: event.output,
              reasoning: event.reasoning,
              cache: { read: event.cacheRead, write: event.cacheWrite },
              total: event.total,
            }
            await promise(sessions.updateMessage(info))
            return
          }
          const existing = parts.get(event.id)
          const base = { id: existing?.id ?? PartID.ascending(), sessionID: input.sessionID, messageID: info.id }
          let part: MessageV2.Part
          if (event.type === "tool") {
            const start = existing?.type === "tool" && "time" in existing.state ? existing.state.time.start : Date.now()
            part = {
              ...base,
              type: "tool",
              callID: event.id,
              tool: event.name,
              metadata: { providerExecuted: true },
              state: event.error
                ? { status: "error", input: event.input, error: event.error, time: { start, end: Date.now() } }
                : event.done
                  ? {
                      status: "completed",
                      input: event.input,
                      title: event.name,
                      output: event.output ?? "Completed",
                      metadata: {},
                      time: { start, end: Date.now() },
                    }
                  : { status: "running", input: event.input, title: event.name, time: { start } },
            }
          } else {
            const before = existing && "text" in existing ? existing.text : ""
            part = {
              ...base,
              type: event.type,
              text: event.replace ? event.text : before + event.text,
              time: { start: info.time.created },
            }
          }
          parts.set(event.id, part)
          await promise(sessions.updatePart(part))
        }
        const work = Effect.tryPromise({
          try: (signal) =>
            (id === "codex-subscription" ? runCodex : runClaude)({
              model: input.user.model.modelID,
              effort: input.user.model.variant,
              cwd: ctx.directory,
              nativeID: saved?.nativeID,
              nativeOwner: saved?.owner,
              messageID: input.user.id,
              text: prompt,
              images: current.parts.flatMap((p) => (p.type === "file" && p.mime.startsWith("image/") ? [p.url] : [])),
              instructions: input.instructions,
              readOnly: input.user.agent === "plan",
              signal,
              mcp,
              emit,
              native: (nativeID, owner) =>
                promise(storage.write(key, { nativeID, owner, assistantID: info.id } satisfies Saved)),
              approve: async (name, value, callID) => {
                if (input.user.agent === "plan") return false
                const permission = /bash|command/i.test(name)
                  ? "bash"
                  : /edit|write|fileChange/i.test(name)
                    ? "edit"
                    : name
                const pattern =
                  typeof value.command === "string"
                    ? value.command
                    : typeof value.file_path === "string"
                      ? value.file_path
                      : name
                return promise(
                  permissions
                    .ask({
                      sessionID: input.sessionID,
                      permission,
                      patterns: [pattern],
                      always: [],
                      metadata: value,
                      tool: { messageID: info.id, callID },
                      ruleset: [{ permission: "*", pattern: "*", action: "ask" }, ...(session.permission ?? [])],
                    })
                    .pipe(
                      Effect.map(() => true),
                      Effect.catch(() => Effect.succeed(false)),
                    ),
                )
              },
              question: async (items) =>
                (
                  await promise(
                    questions.ask({
                      sessionID: input.sessionID,
                      questions: items.map(
                        (q) => new Question.Info({ ...q, options: q.options.map((o) => new Question.Option(o)) }),
                      ),
                    }),
                  )
                ).map((a) => [...a]),
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        })
        yield* work.pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              info.error = new NamedError.Unknown({ message: error.message }).toObject()
            }),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* clearPendingRequests(input.sessionID).pipe(
                Effect.provideService(Permission.Service, permissions),
                Effect.provideService(Question.Service, questions),
              )
              for (const part of parts.values()) {
                if (part.type !== "tool" || part.state.status !== "running") continue
                part.state = {
                  status: "error",
                  input: part.state.input,
                  error: "Research stopped before this tool completed.",
                  time: { start: part.state.time.start, end: Date.now() },
                }
                yield* sessions.updatePart(part)
              }
            }),
          ),
        )
        for (const part of parts.values()) {
          if (part.type === "tool" && part.state.status === "running") {
            part.state = {
              status: "error",
              input: part.state.input,
              error: "Research stopped before this tool completed.",
              time: { start: part.state.time.start, end: Date.now() },
            }
            yield* sessions.updatePart(part)
          }
          if (part.type === "text" || part.type === "reasoning") {
            part.time = { start: part.time?.start ?? info.time.created, end: Date.now() }
            yield* sessions.updatePart(part)
          }
        }
        info.time.completed = Date.now()
        info.finish = "stop"
        yield* sessions.updateMessage(info)
        if (Session.isDefaultTitle(session.title)) {
          const title = text(current).replace(/\s+/g, " ").slice(0, 80).trim()
          if (title) yield* sessions.setTitle({ sessionID: input.sessionID, title })
        }
        return { info, parts: [...parts.values()] }
      })
      return Service.of({ run })
    }),
  )
  export const defaultLayer = layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(Config.defaultLayer),
  )
}
