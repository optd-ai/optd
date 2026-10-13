// Test-only access to an already-issued credential for direct HTTP parity and
// revocation checks. Never infer, mint, rebind, or expose credentials via the CLI.
export async function readTestAuthorizationToken(
  root: string,
  authorizationId: string,
): Promise<string> {
  for await (const entry of Deno.readDir(root)) {
    if (entry.isSymlink) continue;
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      const found = await readTestAuthorizationToken(path, authorizationId);
      if (found) return found;
    } else if (entry.name === "metadata.json") {
      const metadata = JSON.parse(await Deno.readTextFile(path));
      if (
        metadata.record_type === "session" &&
        metadata.credential_type === "agent" &&
        metadata.authorization_id === authorizationId
      ) {
        return await Deno.readTextFile(`${root}/token`);
      }
    }
  }
  return "";
}
