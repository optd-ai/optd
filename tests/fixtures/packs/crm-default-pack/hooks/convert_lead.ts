const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const lead = envelope.input?.lead ?? envelope.input?.current ??
  envelope.input ?? {};
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
  summary: "Convert lead into company, contact, and opportunity.",
  operations: [
    {
      op: "create",
      resource: "company",
      as: "company",
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
      as: "contact",
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
      as: "opportunity",
      fields: {
        name: `${companyName} opportunity`,
        company_id: "@company",
        contact_id: "@contact",
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
      from: "@contact",
      to: "@company",
      fields: { role: "buyer", primary: true },
    },
    {
      op: "link",
      relationship: "opportunity_company",
      from: "@opportunity",
      to: "@company",
      fields: { role: "customer" },
    },
    {
      op: "link",
      relationship: "opportunity_contact",
      from: "@opportunity",
      to: "@contact",
      fields: { role: "decision_maker", primary: true },
    },
    {
      op: "transition",
      resource: "lead",
      id: lead.id,
      to: "converted",
      expectedVersion: lead.version,
    },
  ],
}));
