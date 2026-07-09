import { Hono } from "npm:hono";
import { Type } from "npm:@sinclair/typebox";
import * as AjvModule from "npm:ajv/dist/2020.js";

type Lead = { id: string; name: string; email?: string };
type LeadRepository = {
  create(input: Lead): Promise<Lead>;
  get(id: string): Promise<Lead | undefined>;
};
type TransactionManager = { transaction<T>(fn: () => Promise<T>): Promise<T> };

type CreateLeadCommand = { id: string; name: string; email?: string };

export function makeCreateLeadService(
  deps: { leads: LeadRepository; tx: TransactionManager },
) {
  return async (command: CreateLeadCommand) => {
    return await deps.tx.transaction(async () =>
      await deps.leads.create(command)
    );
  };
}

export class InMemoryLeadRepository implements LeadRepository {
  rows = new Map<string, Lead>();
  async create(input: Lead) {
    if (this.rows.has(input.id)) throw new Error("duplicate lead");
    this.rows.set(input.id, input);
    return input;
  }
  async get(id: string) {
    return this.rows.get(id);
  }
}

export class NoopTransactionManager implements TransactionManager {
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return await fn();
  }
}

export class RawSqlLeadRepository implements LeadRepository {
  constructor(
    private db: {
      queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
    },
  ) {}
  async create(input: Lead) {
    await this.db.queryObject(
      "insert into leads(id, name, email) values ($1, $2, $3)",
      [input.id, input.name, input.email ?? null],
    );
    return input;
  }
  async get(id: string) {
    return (await this.db.queryObject<Lead>(
      "select id, name, email from leads where id=$1",
      [id],
    )).rows[0];
  }
}

const CreateLeadSchema = Type.Object({
  id: Type.String(),
  name: Type.String({ minLength: 1 }),
  email: Type.Optional(Type.String()),
}, { additionalProperties: false });
const AjvCtor = (AjvModule as any).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true });
const validateCreateLead = ajv.compile(CreateLeadSchema);

export function makeHttpApp(
  deps: {
    createLead: (command: CreateLeadCommand) => Promise<Lead>;
    leads: LeadRepository;
  },
) {
  const app = new Hono();
  app.post("/leads", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (!validateCreateLead(body)) {
      return c.json({
        ok: false,
        error: {
          code: "schema_validation_failed",
          details: validateCreateLead.errors,
        },
      }, 400);
    }
    const lead = await deps.createLead(body as CreateLeadCommand);
    return c.json({ ok: true, lead });
  });
  app.get("/leads/:id", async (c) => {
    const lead = await deps.leads.get(c.req.param("id"));
    if (!lead) return c.json({ ok: false, error: { code: "not_found" } }, 404);
    return c.json({ ok: true, lead });
  });
  return app;
}

export function makeInMemoryApp() {
  const leads = new InMemoryLeadRepository();
  const createLead = makeCreateLeadService({
    leads,
    tx: new NoopTransactionManager(),
  });
  return makeHttpApp({ createLead, leads });
}
