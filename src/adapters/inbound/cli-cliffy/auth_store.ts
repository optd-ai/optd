import { dirname, join } from "jsr:@std/path";

type OriginState = {
  token?: string;
  requestToken?: string;
  projectId?: string;
  projectSlug?: string;
};
type Store = { origins: Record<string, OriginState> };

function path(): string {
  const root = Deno.env.get("XDG_CONFIG_HOME") ??
    join(Deno.env.get("HOME") ?? ".", ".config");
  return join(root, "operant", "auth.json");
}
export async function readOrigin(origin: string): Promise<OriginState> {
  try {
    const stat = await Deno.stat(path());
    if ((stat.mode ?? 0) & 0o077) {
      throw new Error("auth_store_permissions_unsafe");
    }
    const store = JSON.parse(await Deno.readTextFile(path())) as Store;
    return store.origins?.[new URL(origin).origin] ?? {};
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
}
export async function writeOrigin(
  origin: string,
  update: OriginState,
): Promise<void> {
  const file = path();
  await Deno.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let store: Store = { origins: {} };
  try {
    store = JSON.parse(await Deno.readTextFile(file));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const key = new URL(origin).origin;
  store.origins[key] = { ...store.origins[key], ...update };
  const temporary = `${file}.${Deno.pid}.${crypto.randomUUID()}`;
  await Deno.writeTextFile(temporary, JSON.stringify(store), {
    createNew: true,
    mode: 0o600,
  });
  await Deno.rename(temporary, file);
  await Deno.chmod(file, 0o600);
}
