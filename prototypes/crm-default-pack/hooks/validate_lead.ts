const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const operation = envelope.input?.operation ?? envelope.input?.proposed ?? {};
const fields = operation.fields ?? operation;
const errors = [];
const warnings = [];
if (!fields.name || String(fields.name).trim() === "") {
  errors.push({
    path: "/fields/name",
    code: "required",
    message: "Lead name is required.",
  });
}
if (!fields.email && !fields.phone) {
  errors.push({
    path: "/fields",
    code: "contact_method_required",
    message: "Lead requires an email or phone.",
  });
}
if (fields.email && !String(fields.email).includes("@")) {
  errors.push({
    path: "/fields/email",
    code: "format",
    message: "Lead email must contain @.",
  });
}
if (!fields.company_name) {
  warnings.push({
    path: "/fields/company_name",
    code: "missing_company",
    message: "Company name improves conversion quality.",
  });
}
console.error(
  `validate_lead errors=${errors.length} warnings=${warnings.length}`,
);
console.log(JSON.stringify({ errors, warnings }));
