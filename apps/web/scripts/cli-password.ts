import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

export async function readConfirmedPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Password entry requires an attached interactive TTY.");
  if (
    Object.keys(process.env).some((key) =>
      /^(?:ADMIN_|STUDIO_)?PASSWORD$/iu.test(key),
    )
  )
    throw new Error("Password environment variables are refused.");
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    execFileSync("stty", ["-echo"], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    const first = await terminal.question("Password: ");
    process.stdout.write("\n");
    const second = await terminal.question("Confirm password: ");
    process.stdout.write("\n");
    if (first !== second) throw new Error("Passwords do not match.");
    return first;
  } finally {
    try {
      execFileSync("stty", ["echo"], {
        stdio: ["inherit", "inherit", "inherit"],
      });
    } catch {
      /* terminal restoration is best effort */
    }
    terminal.close();
  }
}

export function parseNamedArguments(argv: string[]) {
  let username = "";
  let displayName = "";
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const value = argv[index + 1];
    if (current === "--username" && value) {
      username = value;
      index += 1;
    } else if (current === "--display-name" && value) {
      displayName = value;
      index += 1;
    } else
      throw new Error(
        'Usage: --username NAME [--display-name "Display Name"]. Password arguments are never accepted.',
      );
  }
  if (!username) throw new Error("A username is required.");
  return {
    username: username.normalize("NFKC").trim().toLowerCase(),
    displayName: displayName.trim() || username,
  };
}
