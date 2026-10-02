import { randomBytes } from "node:crypto";

import { hashPassword } from "./kuma/auth.js";

/**
 * Small operational CLI.
 *
 *   pnpm bridge password hash      → prompts for a password, prints an Argon2id hash
 *   pnpm bridge password check HASH → verifies a hash against a password
 *   pnpm bridge secret              → prints a random JWT secret
 *
 * Passwords are read from stdin with echo disabled when a TTY is available, and
 * never passed as an argument (argv is visible in `ps` and in shell history).
 */

function usage(): never {
  process.stdout.write(
    [
      "Usage:",
      "  pnpm bridge password hash",
      "  pnpm bridge password check <hash>",
      "  pnpm bridge secret",
      "",
    ].join("\n"),
  );
  process.exit(64);
}

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const value = Buffer.concat(chunks).toString("utf8").trim();
    if (value.length === 0) throw new Error("no password provided on stdin");
    return value;
  }

  process.stdout.write(prompt);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        switch (char) {
          case "\n":
          case "\r":
          case "":
            cleanup();
            process.stdout.write("\n");
            resolve(value);
            return;
          case "":
            cleanup();
            process.stdout.write("\n");
            reject(new Error("aborted"));
            return;
          case "": // backspace
            value = value.slice(0, -1);
            break;
          default:
            // Ignore control characters so arrow keys do not leak into the secret.
            if (char >= " ") value += char;
        }
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const [group, action, argument] = process.argv.slice(2);

  if (group === "secret") {
    process.stdout.write(`${randomBytes(48).toString("base64url")}\n`);
    return;
  }

  if (group !== "password") usage();

  if (action === "hash") {
    const password = await readPassword("Password: ");
    const confirmation = await readPassword("Confirm password: ");
    if (password !== confirmation) {
      process.stderr.write("Passwords do not match.\n");
      process.exit(65);
    }
    if (password.length < 12) {
      process.stderr.write("Refusing: use at least 12 characters. This endpoint is internet-facing.\n");
      process.exit(65);
    }
    process.stdout.write(`${await hashPassword(password)}\n`);
    return;
  }

  if (action === "check") {
    if (!argument) usage();
    const { verifyPassword } = await import("./kuma/auth.js");
    const password = await readPassword("Password: ");
    const ok = await verifyPassword(password, argument);
    process.stdout.write(ok ? "ok\n" : "mismatch\n");
    process.exit(ok ? 0 : 1);
  }

  usage();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});