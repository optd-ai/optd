const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const lead = envelope.input.lead;
const leadId = envelope.input.input.lead_id;
const companyName = lead.company_name ?? `${lead.name ?? "New"} Company`;
const contactName = lead.name ?? "New Contact";
const present = (fields: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null),
  );
console.error(`convert_lead generating operations for ${leadId}`);
console.log(JSON.stringify({
  operations: [
    {
      op: "create",
      resource: "optd/crm:company",
      key: "company",
      fields: present({
        name: companyName,
        email: lead.email,
        phone: lead.phone,
        owner_id: lead.owner_id,
      }),
    },
    {
      op: "create",
      resource: "optd/crm:contact",
      key: "contact",
      fields: present({
        name: contactName,
        email: lead.email,
        phone: lead.phone,
        owner_id: lead.owner_id,
      }),
    },
    {
      op: "create",
      resource: "optd/crm:opportunity",
      key: "opportunity",
      fields: present({
        name: `${companyName} opportunity`,
        company_id: { $ref: "company.object_id" },
        contact_id: { $ref: "contact.object_id" },
        lead_id: leadId,
        expected_revenue: "0",
        probability: 30,
        owner_id: lead.owner_id,
        sales_team_id: lead.sales_team_id,
      }),
    },
    {
      op: "link",
      relationship: "optd/crm:contact_company",
      from: { $ref: "contact.object_id" },
      to: { $ref: "company.object_id" },
      fields: { role: "buyer", primary: true },
    },
    {
      op: "link",
      relationship: "optd/crm:opportunity_company",
      from: { $ref: "opportunity.object_id" },
      to: { $ref: "company.object_id" },
      fields: { role: "customer" },
    },
    {
      op: "link",
      relationship: "optd/crm:opportunity_contact",
      from: { $ref: "opportunity.object_id" },
      to: { $ref: "contact.object_id" },
      fields: { role: "decision_maker", primary: true },
    },
    {
      op: "update",
      resource: "optd/crm:lead",
      object_id: leadId,
      set: { status: "converted" },
    },
  ],
}));
