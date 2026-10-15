const harnesses = new Set([
  "pi",
  "codex",
  "claude",
  "opencode",
  "cursor-agent",
  "aider",
  "goose",
]);
const basename = (path: string) => path.split("/").at(-1)!.replace(/^-/, "");

export function isAgentHarness(argv: string[]): boolean {
  if (!argv.length) return false;
  const name = basename(argv[0]);
  if (harnesses.has(name)) return true;
  if (["node", "nodejs", "bun", "python", "python3"].includes(name)) {
    const entry = argv[1] ?? "";
    return harnesses.has(basename(entry).replace(/\.(?:[cm]?js|py)$/, "")) ||
      /\/(?:pi-coding-agent|@anthropic-ai\/claude-code|@openai\/codex)\//.test(
        entry,
      );
  }
  return false;
}
