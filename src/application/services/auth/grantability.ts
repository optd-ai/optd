import type {
  AgentAuthorizationGrantability,
  AgentAuthorizationGrantabilitySnapshot,
} from "../../ports/authentication.ts";
import type { Result } from "../../../domain/errors/result.ts";
import { err, ok } from "../../../domain/errors/result.ts";

export class CurrentPolicyAgentAuthorizationGrantability
  implements AgentAuthorizationGrantability {
  async canDecide(
    input: Parameters<AgentAuthorizationGrantability["canDecide"]>[0],
  ): Promise<Result<AgentAuthorizationGrantabilitySnapshot>> {
    const current = await input.state.current(input);
    if (!current.ok) return current;
    if (current.value.superAdmin) return ok(current.value.snapshot);
    if (!current.value.canDecide) return denied();
    if (
      input.decision === "approved" &&
      input.roles.some((role) => !current.value.effectiveRoles.includes(role))
    ) {
      return err({
        code: "authorization_insufficient",
        message:
          "the decider does not currently possess every requested role in the requested boundary",
        severity: "authorization",
        details: {
          missing_roles: input.roles.filter((role) =>
            !current.value.effectiveRoles.includes(role)
          ),
        },
      });
    }
    return ok(current.value.snapshot);
  }
}

function denied() {
  return err({
    code: "authorization_insufficient",
    message: "auth.request.decide is required in the requested boundary",
    severity: "authorization",
    details: { capability: "auth.request.decide" },
  });
}
