import { assertEquals } from "jsr:@std/assert";
import {
  InMemoryLeadRepository,
  makeCreateLeadService,
  makeInMemoryApp,
  NoopTransactionManager,
} from "./hexagonal-skeleton.ts";

Deno.test("application service uses ports without Hono dependency", async () => {
  const leads = new InMemoryLeadRepository();
  const service = makeCreateLeadService({
    leads,
    tx: new NoopTransactionManager(),
  });
  const lead = await service({
    id: "lead_1",
    name: "Ada",
    email: "ada@example.com",
  });
  assertEquals(lead.id, "lead_1");
  assertEquals((await leads.get("lead_1"))?.name, "Ada");
});

Deno.test("Hono adapter validates input and delegates to service", async () => {
  const app = makeInMemoryApp();
  const bad = await app.request("/leads", {
    method: "POST",
    body: JSON.stringify({ id: "lead_1" }),
  });
  assertEquals(bad.status, 400);
  const good = await app.request("/leads", {
    method: "POST",
    body: JSON.stringify({ id: "lead_1", name: "Ada" }),
  });
  assertEquals(good.status, 200);
  const get = await app.request("/leads/lead_1");
  assertEquals((await get.json()).lead.name, "Ada");
});
