const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const envName = envelope.input.envName ?? "CRM_API_KEY";
const value = Deno.env.get(envName);
if (!value) {
  console.log(
    JSON.stringify({
      allow: false,
      errors: [{
        path: `/env/${envName}`,
        code: "missing_secret",
        message: `${envName} was not injected.`,
      }],
      warnings: [],
    }),
  );
} else {
  console.error(`use_secret received ${envName} with ${value.length} chars`);
  console.log(
    JSON.stringify({
      allow: true,
      errors: [],
      warnings: [{
        path: `/env/${envName}`,
        code: "secret_available",
        message: `Secret ${envName} was injected.`,
      }],
    }),
  );
}
