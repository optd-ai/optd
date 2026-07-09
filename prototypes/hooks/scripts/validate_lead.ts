const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const op = envelope.input.operation;
const errors = [];
const warnings = [];
const email = op?.fields?.email ?? op?.set?.email;
if (
  email !== undefined && (typeof email !== "string" || !email.includes("@"))
) {
  errors.push({
    path: "/fields/email",
    code: "invalid_email",
    message: "Email must contain @.",
  });
}
if (!op?.fields?.company_name && !op?.set?.company_name) {
  warnings.push({
    path: "/fields/company_name",
    code: "missing_company",
    message: "Company name improves routing.",
  });
}
console.error(
  `validate_lead errors=${errors.length} warnings=${warnings.length}`,
);
console.log(
  JSON.stringify({
    allow: errors.length === 0,
    errors,
    warnings,
    summary: "Validated lead input.",
  }),
);
