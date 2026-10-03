import { Hono } from "hono"
import { validator } from "hono-openapi"
import z from "zod"
import { connections, startLogin, loginState, cancelLogin } from "../../subscription/connections"
import { runtimeIDs, subscriptionOnly } from "../../subscription/types"

const params = validator("param", z.object({ id: z.enum(runtimeIDs) }))
export const SubscriptionRoutes = () =>
  new Hono()
    .get("/mode", (c) => c.json({ enabled: subscriptionOnly() }))
    .get("/", async (c) =>
      c.json({
        enabled: subscriptionOnly(),
        connections: subscriptionOnly() ? await connections(c.req.query("refresh") === "true") : [],
      }),
    )
    .post("/:id/login", params, async (c) => c.json(await startLogin(c.req.valid("param").id)))
    .get("/:id/login", params, (c) => c.json(loginState(c.req.valid("param").id)))
    .delete("/:id/login", params, (c) => {
      cancelLogin(c.req.valid("param").id)
      return c.json(true)
    })
