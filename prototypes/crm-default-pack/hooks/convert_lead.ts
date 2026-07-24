const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const lead = envelope.input.lead;
if (!lead.id) {
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
  Deno.exit(0);
}
const companyName = lead.company_name ?? `${lead.name ?? "New"} Company`;
const contactName = lead.name ?? "New Contact";
console.error(`convert_lead generating operations for ${lead.id}`);
console.log(JSON.stringify({
  operations: [
    {
      op: "create",
      resource: "company",
      key: "company",
      fields: {
        name: companyName,
        email: lead.email,
        phone: lead.phone,
        owner_id: lead.owner_id,
      },
    },
    {
      op: "create",
      resource: "contact",
      key: "contact",
      fields: {
        name: contactName,
        email: lead.email,
        phone: lead.phone,
        owner_id: lead.owner_id,
      },
    },
    {
      op: "create",
      resource: "opportunity",
      key: "opportunity",
      fields: {
        name: `${companyName} opportunity`,
        company_id: { $ref: "company.object_id" },
        contact_id: { $ref: "contact.object_id" },
        lead_id: lead.id,
        stage: "qualified",
        expected_revenue: 0,
        probability: 30,
        owner_id: lead.owner_id,
        sales_team_id: lead.sales_team_id,
      },
    },
    {
      op: "link",
      relationship: "contact_company",
      from: { $ref: "contact.object_id" },
      to: { $ref: "company.object_id" },
      fields: { role: "buyer", primary: true },
    },
    {
      op: "link",
      relationship: "opportunity_company",
      from: { $ref: "opportunity.object_id" },
      to: { $ref: "company.object_id" },
      fields: { role: "customer" },
    },
    {
      op: "link",
      relationship: "opportunity_contact",
      from: { $ref: "opportunity.object_id" },
      to: { $ref: "contact.object_id" },
      fields: { role: "decision_maker", primary: true },
    },
    {
      op: "transition",
      resource: "lead",
      object_id: lead.id,
      to: "converted",
      expected_version: lead.version,
    },
  ],
}));
