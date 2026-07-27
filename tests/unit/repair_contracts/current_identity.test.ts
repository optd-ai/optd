import { assert, assertFalse } from "jsr:@std/assert";
import { currentIdentityContract } from "../../../src/schemas/repair/current_identity.ts";

const human = {
  credential_kind: "human_full",
  principal: { id: "principal-human", type: "human_user" },
  human_user: {
    id: "human-1",
    principal_id: "principal-human",
    username: "admin",
    display_name: "Admin",
    status: "active",
  },
  role_assignments: [{
    role: "system:super_admin",
    boundary: { type: "system" },
  }],
  session: { id: "session-1" },
  auth_context: { id: "context-1", active: true },
} as const;

const agent = {
  credential_kind: "agent_authorization",
  principal: { id: "principal-agent", type: "agent_user" },
  human_user: human.human_user,
  agent: {
    id: "agent-1",
    principal_id: "principal-agent",
    name: "assistant",
    authorization_id: "authorization-2",
    parent_authorization_id: "authorization-1",
    root_authorization_id: "authorization-1",
    authorization_ancestry_ids: ["authorization-1", "authorization-2"],
  },
  role_assignments: [{
    role: "crm:sales_rep",
    boundary: { type: "project", project_id: "project-1" },
  }],
  session: { id: "session-agent" },
  auth_context: { id: "context-agent", active: true },
} as const;

Deno.test("current identity has explicit human and agent structures", () => {
  assert(currentIdentityContract.check(human));
  assert(currentIdentityContract.check(agent));
});

Deno.test("current identity rejects aliases, unknown fields, and contradictory shapes", () => {
  assertFalse(currentIdentityContract.check({ ...agent, id: "agent-1" }));
  assertFalse(currentIdentityContract.check({
    ...agent,
    principal_type: "human_user",
  }));
  assertFalse(currentIdentityContract.check({
    ...agent,
    agent: { ...agent.agent, token: "secret" },
  }));
  assertFalse(currentIdentityContract.check({
    ...agent,
    principal: { id: "principal-agent", type: "human_user" },
  }));
  assertFalse(currentIdentityContract.check({
    ...human,
    agent: agent.agent,
  }));
});
