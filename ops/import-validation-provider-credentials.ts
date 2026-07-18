import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function parseEnvironment(body: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of body.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match?.[1] || match[2] === undefined) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values;
}

async function main() {
  const studioRoot = path.resolve(import.meta.dirname, "..");
  const sourcePath = path.resolve(
    process.env.STUDIO_PROVIDER_SOURCE_ENV ??
      path.join(studioRoot, "../pragueMenus/.env"),
  );
  const targetPath = path.resolve(
    process.env.STUDIO_PROVIDER_TARGET_ENV ??
      path.join(studioRoot, ".env.worker.local"),
  );
  const source = parseEnvironment(await readFile(sourcePath, "utf8"));
  const claudeToken = source.get("CLAUDE_CODE_OAUTH_TOKEN");
  if (!claudeToken)
    throw new Error("CLAUDE_CODE_OAUTH_TOKEN is unavailable in the source.");

  const target = [
    "# Generated for isolated owner validation; never deploy as production auth.",
    "STUDIO_RUNTIME_ENV=validation",
    "PROVIDER_EXECUTION_MODE=cli",
    `CLAUDE_CODE_OAUTH_TOKEN=${claudeToken}`,
    "",
  ].join("\n");
  await writeFile(targetPath, target, { encoding: "utf8", mode: 0o600 });
  await chmod(targetPath, 0o600);
  process.stdout.write(
    `Imported one validation-only provider credential into ${targetPath}; values were not printed.\n`,
  );
}

void main();
