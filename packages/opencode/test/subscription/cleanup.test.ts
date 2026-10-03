import { afterEach, expect } from "bun:test"
import { Effect, Fiber, Exit, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { SessionID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { clearPendingRequests } from "../../src/subscription/cleanup"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const bus = Bus.layer
const it = testEffect(
  Layer.mergeAll(Permission.layer, Question.layer).pipe(
    Layer.provideMerge(bus),
    Layer.provideMerge(CrossSpawnSpawner.defaultLayer),
  ),
)
afterEach(() => Instance.disposeAll())

it.live("cancellation clears sibling approvals while preserving another session", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const session = SessionID.make("ses_subscription_cancel")
      const other = SessionID.make("ses_subscription_other")
      const asks = []
      for (const sessionID of [session, session, other]) {
        asks.push(
          yield* permission
            .ask({
              sessionID,
              permission: "bash",
              patterns: ["cat fixture.txt"],
              always: [],
              metadata: {},
              ruleset: [{ permission: "*", pattern: "*", action: "ask" }],
            })
            .pipe(Effect.forkScoped),
        )
      }
      for (let i = 0; (yield* permission.list()).length < 3 && i < 100; i++) yield* Effect.sleep("10 millis")
      expect(yield* permission.list()).toHaveLength(3)
      yield* clearPendingRequests(session)
      expect((yield* permission.list()).map((request) => request.sessionID)).toEqual([other])
      expect(Exit.isFailure(yield* Fiber.await(asks[0]))).toBe(true)
      expect(Exit.isFailure(yield* Fiber.await(asks[1]))).toBe(true)
      yield* clearPendingRequests(session)
      yield* clearPendingRequests(other)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  ),
)
