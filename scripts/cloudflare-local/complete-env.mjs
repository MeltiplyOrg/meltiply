// Completes a private local environment file before setup starts services. Missing or
// blank application secrets receive cryptographic random values once; existing values
// are never rotated. Secret values stay in the file and are never printed or exported.
import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const target = process.argv[2] || ".env";
let content = await readFile(target, "utf8");
const environment = parseEnv(content);
const generated = [];
for (const name of ["BETTER_AUTH_SECRET", "AUTH_SETUP_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
  if (environment[name]?.trim()) continue;
  const assignment = `${name}=${randomBytes(32).toString("base64url")}`;
  const existing = new RegExp(`^(?:export[ \\t]+)?${name}[ \\t]*=.*$`, "m");
  content = existing.test(content)
    ? content.replace(existing, assignment)
    : `${content.endsWith("\n") ? content : `${content}\n`}${assignment}\n`;
  generated.push(name);
}
await chmod(target, 0o600);
if (generated.length > 0) {
  await writeFile(target, content, { mode: 0o600 });
  console.log(`Initialized missing local secrets in ${target}: ${generated.join(", ")}`);
}
