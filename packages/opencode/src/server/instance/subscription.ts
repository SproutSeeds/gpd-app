import { Hono } from "hono"
import { validator } from "hono-openapi"
import z from "zod"
import { connections, startLogin, loginState, cancelLogin, disconnect } from "../../subscription/connections"
import { runtimeIDs, subscriptionOnly } from "../../subscription/types"

const params = validator("param", z.object({ id: z.enum(runtimeIDs) }))
export const SubscriptionRoutes = (runtime = { connections, startLogin, loginState, cancelLogin, disconnect }) =>
  new Hono()
    .get("/mode", (c) => c.json({ enabled: subscriptionOnly() }))
    .get("/", async (c) =>
      c.json({
        enabled: subscriptionOnly(),
        connections: subscriptionOnly() ? await runtime.connections(c.req.query("refresh") === "true") : [],
      }),
    )
    .post("/:id/login", params, async (c) => c.json(await runtime.startLogin(c.req.valid("param").id)))
    .get("/:id/login", params, (c) => c.json(runtime.loginState(c.req.valid("param").id)))
    .post("/:id/disconnect", params, async (c) => {
      await runtime.disconnect(c.req.valid("param").id)
      return c.json(true)
    })
    .delete("/:id/login", params, (c) => {
      runtime.cancelLogin(c.req.valid("param").id)
      return c.json(true)
    })
