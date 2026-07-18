import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const ignored = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "test-results",
  "playwright-report",
]);
const patterns = [
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  },
  { name: "OpenAI key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u },
  { name: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u },
  {
    name: "credentialed PostgreSQL URL",
    pattern:
      /postgres(?:ql)?:\/\/(?!invalid:invalid|situation_studio_web:replace-me)[^\s:@]+:[^\s@]+@/iu,
  },
];
const findings: string[] = [];

function walk(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name.startsWith(".env")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile() && fs.statSync(absolute).size < 2_000_000) {
      const body = fs.readFileSync(absolute, "utf8");
      for (const candidate of patterns)
        if (candidate.pattern.test(body))
          findings.push(`${path.relative(root, absolute)}: ${candidate.name}`);
    }
  }
}
walk(root);
if (findings.length)
  throw new Error(`Secret scan failed:\n- ${findings.join("\n- ")}`);
process.stdout.write("Secret scan passed.\n");
