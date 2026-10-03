import { Effect } from "effect"
import { Permission } from "../permission"
import { Question } from "../question"
import type { SessionID } from "../session/schema"

export const clearPendingRequests = Effect.fn("SubscriptionSession.clearPendingRequests")(function* (
  sessionID: SessionID,
) {
  const permissions = yield* Permission.Service
  const questions = yield* Question.Service
  // A rejection clears every pending permission in this session. Replying to
  // a stale snapshot of siblings would throw 404 and prevent tool cleanup.
  const pending = (yield* permissions.list()).find((request) => request.sessionID === sessionID)
  if (pending)
    yield* permissions.reply({ requestID: pending.id, reply: "reject" }).pipe(Effect.catchCause(() => Effect.void))
  for (const request of yield* questions.list()) {
    if (request.sessionID === sessionID) yield* questions.reject(request.id).pipe(Effect.catchCause(() => Effect.void))
  }
})
