const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const lead = envelope.input.lead;
if (!lead?.id) {
  console.log(
    JSON.stringify({
      operations: [],
      errors: [{
        path: "/lead/id",
        code: "required",
        message: "Lead id is required.",
      }],
    }),
  );
} else {
  const companyName = lead.company_name ?? `${lead.name} Company`;
  console.error(`convert_lead generating operations for ${lead.id}`);
  console.log(JSON.stringify({
    summary: "Convert lead into company, contact, and opportunity.",
    operations: [
      {
        op: "create",
        resource: "company",
        as: "company",
        fields: { name: companyName },
      },
      {
        op: "create",
        resource: "contact",
        as: "contact",
        fields: { name: lead.name, email: lead.email },
      },
      {
        op: "create",
        resource: "opportunity",
        as: "opportunity",
        fields: {
          name: `${companyName} opportunity`,
          company_id: "@company",
          contact_id: "@contact",
          stage: "new",
        },
      },
      {
        op: "link",
        relationship: "contact_company",
        from: "@contact",
        to: "@company",
        fields: { role: "buyer" },
      },
      {
        op: "transition",
        resource: "lead",
        id: lead.id,
        to: "qualified",
        expectedVersion: lead.version,
      },
    ],
  }));
}
