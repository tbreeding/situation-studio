import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
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
      /postgres(?:ql)?:\/\/(?![^\s:@/]+:(?:invalid|replace-me)@)[^\s:@]+:[^\s@]+@/iu,
  },
];
const findings: string[] = [];

const candidates = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

for (const relative of candidates) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || fs.statSync(absolute).size >= 2_000_000)
    continue;
  const body = fs.readFileSync(absolute, "utf8");
  for (const candidate of patterns)
    if (candidate.pattern.test(body))
      findings.push(`${relative}: ${candidate.name}`);
}
if (findings.length)
  throw new Error(`Secret scan failed:\n- ${findings.join("\n- ")}`);
process.stdout.write("Secret scan passed.\n");
