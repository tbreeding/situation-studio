import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/u,
  /\bsk-ant-[A-Za-z0-9_-]{24,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bghp_[A-Za-z0-9]{30,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/u,
] as const;

const allowed = new Set([".env.example", "SPEC-situation-studio-redesign.md"]);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const fileGroups = await Promise.all([
  executeFile(
    "rg",
    ["--files", "-g", "!node_modules", "-g", "!.next", "-g", "!coverage"],
    { cwd: repositoryRoot, maxBuffer: 8 * 1024 * 1024 },
  ).then((result) => result.stdout.split("\n")),
  executeFile("rg", ["--files", "--hidden", "--no-ignore", ".next/static"], {
    cwd: repositoryRoot,
    maxBuffer: 8 * 1024 * 1024,
  })
    .then((result) => result.stdout.split("\n"))
    .catch(() => []),
  executeFile(
    "rg",
    [
      "--files",
      "--hidden",
      "--no-ignore",
      "-g",
      "*.log",
      "-g",
      "!node_modules/**",
      "-g",
      "!.git/**",
      "-g",
      "!playwright-report/**",
      "-g",
      "!test-results/**",
    ],
    { cwd: repositoryRoot, maxBuffer: 8 * 1024 * 1024 },
  )
    .then((result) => result.stdout.split("\n"))
    .catch(() => []),
]);
const findings: string[] = [];
for (const path of new Set(fileGroups.flat().filter(Boolean))) {
  if (allowed.has(path) || /\.(?:png|jpg|jpeg|gif|tgz|lock)$/iu.test(path))
    continue;
  const body = await readFile(
    path.startsWith("/") ? path : `${repositoryRoot}/${path}`,
    "utf8",
  ).catch(() => "");
  if (patterns.some((pattern) => pattern.test(body))) findings.push(path);
}
if (findings.length)
  throw new Error(`Secret-like material found in: ${findings.join(", ")}`);
process.stdout.write("Secret scan passed.\n");
