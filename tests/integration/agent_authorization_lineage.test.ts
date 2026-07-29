// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { PostgresAuthRepository } from "../../src/adapters/outbound/postgres/auth_repository.ts";
import { PostgresAuthorizationRepository } from "../../src/adapters/outbound/postgres/authorization_repository.ts";
import {
  query,
  type Sql,
} from "../../src/adapters/outbound/postgres/client.ts";
import { opaqueToken, tokenDigest } from "../../src/domain/auth/token.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import { startLiveHarness } from "../support/live_harness.ts";

type Fixture = {
  sql: Sql;
  humanUserId: string;
  approvedByContextId: string;
};

type Authorization = {
  id: string;
  agentUserId: string;
  principalId: string;
};

Deno.test("bearer and current identity fail closed on the complete authorization lineage", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "lineage-admin",
        password: "lineage validation password",
      })).code,
      0,
    );
    const initialized = await harness.runOptctl([
      "--json",
      "auth",
      "whoami",
    ]);
    assertEquals(initialized.code, 0, initialized.stderr);
    const anchor = (await query<{
      human_user_id: string;
      auth_context_id: string;
    }>(
      harness.server.sql,
      `select c.human_user_id,c.id auth_context_id
         from auth_contexts c
        join auth_sessions s on s.id=c.session_id
       where s.credential_kind='human_full'
       order by c.created_at desc limit 1`,
    )).rows[0]!;
    const fixture = {
      sql: harness.server.sql,
      humanUserId: anchor.human_user_id,
      approvedByContextId: anchor.auth_context_id,
    };

    const activeRoot = await authorization(fixture);
    const activeRootSession = await session(fixture, activeRoot);
    const activeRootResponse = await me(
      harness.baseUrl,
      activeRootSession.token,
    );
    assertEquals(activeRootResponse.status, 200);
    assertEquals(
      (await activeRootResponse.json()).data.agent.authorization_ancestry_ids,
      [activeRoot.id],
    );

    const delegatedRoot = await authorization(fixture);
    const delegated = await authorization(fixture, {
      parentId: delegatedRoot.id,
      rootId: delegatedRoot.id,
    });
    const delegatedSession = await session(fixture, delegated);
    const delegatedResponse = await me(harness.baseUrl, delegatedSession.token);
    assertEquals(delegatedResponse.status, 200);
    assertEquals(
      (await delegatedResponse.json()).data.agent.authorization_ancestry_ids,
      [delegatedRoot.id, delegated.id],
    );

    for (const status of ["revoked_at", "superseded_at"] as const) {
      for (const position of ["root", "middle"] as const) {
        const root = await authorization(fixture);
        const middle = await authorization(fixture, {
          parentId: root.id,
          rootId: root.id,
        });
        const leaf = await authorization(fixture, {
          parentId: middle.id,
          rootId: root.id,
        });
        await query(
          fixture.sql,
          `update agent_authorizations set ${status}=now() where id=$1`,
          [position === "root" ? root.id : middle.id],
        );
        await expectInvalidMe(
          harness.baseUrl,
          fixture.sql,
          await session(fixture, leaf),
        );
      }
    }

    const boundaryRoot = await authorization(fixture);
    const boundaryMiddle = await authorization(fixture, {
      parentId: boundaryRoot.id,
      rootId: boundaryRoot.id,
    });
    const boundaryLeaf = await authorization(fixture, {
      parentId: boundaryMiddle.id,
      rootId: boundaryRoot.id,
    });
    const boundarySession = await session(fixture, boundaryLeaf);
    const authRepository = new PostgresAuthRepository(fixture.sql);
    const authenticated = await authRepository.authenticate(
      boundarySession.token,
    );
    assertEquals(authenticated.ok, true);
    if (!authenticated.ok) throw new Error(authenticated.error.message);
    await query(
      fixture.sql,
      `update agent_authorizations set revoked_at=now() where id=$1`,
      [boundaryMiddle.id],
    );
    const current = await authRepository.currentIdentity(authenticated.value);
    assertEquals(current.ok, false);
    if (!current.ok) assertEquals(current.error.code, "credential_invalid");
    const authority = await new PostgresAuthorizationRepository(fixture.sql)
      .authority(authenticated.value, { type: "system" });
    assertEquals(authority.ok, false);
    if (!authority.ok) assertEquals(authority.error.code, "credential_invalid");

    const replacementRoot = await authorization(fixture);
    const replacedLeaf = await authorization(fixture, {
      parentId: replacementRoot.id,
      rootId: replacementRoot.id,
    });
    const replacement = await authorization(fixture, {
      parentId: replacementRoot.id,
      rootId: replacementRoot.id,
      reuseAgent: replacedLeaf,
    });
    await query(
      fixture.sql,
      `update agent_authorizations set superseded_at=now() where id=$1`,
      [replacedLeaf.id],
    );
    await expectInvalidMe(
      harness.baseUrl,
      fixture.sql,
      await session(fixture, replacedLeaf),
    );
    const replacementSession = await session(fixture, replacement);
    const replacementResponse = await me(
      harness.baseUrl,
      replacementSession.token,
    );
    assertEquals(replacementResponse.status, 200);
    assertEquals(
      (await replacementResponse.json()).data.agent.authorization_ancestry_ids,
      [replacementRoot.id, replacement.id],
    );

    const unrelatedRoot = await authorization(fixture);
    const malformedRoot = await authorization(fixture);
    const malformedLeaf = await authorization(fixture, {
      parentId: malformedRoot.id,
      rootId: unrelatedRoot.id,
    });
    await expectInvalidMe(
      harness.baseUrl,
      fixture.sql,
      await session(fixture, malformedLeaf),
    );

    const extra = await authorization(fixture);
    const extraRoot = await authorization(fixture);
    const extraLeaf = await authorization(fixture, {
      parentId: extraRoot.id,
      rootId: extraRoot.id,
    });
    await query(
      fixture.sql,
      `update agent_authorizations set parent_authorization_id=$2 where id=$1`,
      [extraRoot.id, extra.id],
    );
    await expectInvalidMe(
      harness.baseUrl,
      fixture.sql,
      await session(fixture, extraLeaf),
    );

    const otherHumanPrincipal = uuidV7();
    const otherHuman = uuidV7();
    await query(
      fixture.sql,
      `insert into principals(id,type,active) values($1,'human_user',true)`,
      [otherHumanPrincipal],
    );
    await query(
      fixture.sql,
      `insert into human_users(id,principal_id,username,display_name,status)
       values($1,$2,$3,'Other anchor','active')`,
      [otherHuman, otherHumanPrincipal, `other-${otherHuman}`],
    );
    const anchorRoot = await authorization(fixture);
    const mismatchedAnchor = await authorization(fixture, {
      parentId: anchorRoot.id,
      rootId: anchorRoot.id,
      agentHumanUserId: otherHuman,
    });
    await expectInvalidMe(
      harness.baseUrl,
      fixture.sql,
      await session(fixture, mismatchedAnchor),
    );

    const principalRoot = await authorization(fixture);
    const principalLeaf = await authorization(fixture, {
      parentId: principalRoot.id,
      rootId: principalRoot.id,
    });
    const unrelatedPrincipal = uuidV7();
    await query(
      fixture.sql,
      `insert into principals(id,type,active) values($1,'agent_user',true)`,
      [unrelatedPrincipal],
    );
    await expectInvalidMe(
      harness.baseUrl,
      fixture.sql,
      await session(fixture, principalLeaf, unrelatedPrincipal),
    );
  } finally {
    await harness.close();
  }
});

async function authorization(
  fixture: Fixture,
  options: {
    parentId?: string;
    rootId?: string;
    reuseAgent?: Authorization;
    agentHumanUserId?: string;
  } = {},
): Promise<Authorization> {
  const id = uuidV7();
  const agentUserId = options.reuseAgent?.agentUserId ?? uuidV7();
  const principalId = options.reuseAgent?.principalId ?? uuidV7();
  if (!options.reuseAgent) {
    await query(
      fixture.sql,
      `insert into principals(id,type,active) values($1,'agent_user',true)`,
      [principalId],
    );
    await query(
      fixture.sql,
      `insert into agent_users(id,principal_id,human_user_id,name)
       values($1,$2,$3,'lineage fixture')`,
      [
        agentUserId,
        principalId,
        options.agentHumanUserId ?? fixture.humanUserId,
      ],
    );
  }
  await query(
    fixture.sql,
    `insert into agent_authorizations(
       id,agent_user_id,human_user_id,parent_authorization_id,
       root_authorization_id,approved_by_auth_context_id
     ) values($1,$2,$3,$4,$5,$6)`,
    [
      id,
      agentUserId,
      fixture.humanUserId,
      options.parentId ?? null,
      options.rootId ?? id,
      fixture.approvedByContextId,
    ],
  );
  return { id, agentUserId, principalId };
}

async function session(
  fixture: Fixture,
  authorization: Authorization,
  principalId = authorization.principalId,
): Promise<{ id: string; token: string }> {
  const id = uuidV7();
  const token = opaqueToken();
  await query(
    fixture.sql,
    `insert into auth_sessions(
       id,principal_id,human_user_id,credential_kind,token_digest,authorization_id
     ) values($1,$2,$3,'agent_authorization',$4,$5)`,
    [
      id,
      principalId,
      fixture.humanUserId,
      await tokenDigest(token),
      authorization.id,
    ],
  );
  return { id, token };
}

async function expectInvalidMe(
  baseUrl: string,
  sql: Sql,
  credential: { id: string; token: string },
): Promise<void> {
  const before = await contextCount(sql, credential.id);
  const response = await me(baseUrl, credential.token);
  assertEquals(response.status, 401);
  assertEquals((await response.json()).error.code, "credential_invalid");
  assertEquals(await contextCount(sql, credential.id), before);
}

async function contextCount(sql: Sql, sessionId: string): Promise<number> {
  return (await query<{ count: number }>(
    sql,
    `select count(*)::int count from auth_contexts where session_id=$1`,
    [sessionId],
  )).rows[0]!.count;
}

function me(baseUrl: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
