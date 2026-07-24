const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const current = envelope.input.current;
const proposed = envelope.input.proposed;
const requiresApproval = proposed.stage === "won" && current?.stage !== "won";
console.log(JSON.stringify({
  allow: true,
  errors: [],
  warnings: [],
  required_approvals: requiresApproval
    ? [{
      key: "opportunity_won",
      role: "operant/crm:sales_manager",
      boundary: { type: "project", project_id: envelope.input.project_id },
      minimum: 1,
      principal_types: ["human_user"],
      allow_initiator: false,
      expires_at: null,
      reason: "A sales manager must approve won opportunities.",
    }]
    : [],
}));
