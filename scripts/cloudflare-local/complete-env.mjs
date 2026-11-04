// Completes a private local environment file before setup starts services. Missing or
// blank application secrets receive cryptographic random values once; existing values
// are never rotated. Secret values stay in the file and are never printed or exported.
import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const secretAssignments = [
  ["BETTER_AUTH_SECRET", /^(?:export[ \t]+)?BETTER_AUTH_SECRET[ \t]*=.*$/m],
  ["AUTH_SETUP_SECRET", /^(?:export[ \t]+)?AUTH_SETUP_SECRET[ \t]*=.*$/m],
  ["TOKEN_ENCRYPTION_KEY", /^(?:export[ \t]+)?TOKEN_ENCRYPTION_KEY[ \t]*=.*$/m],
];

const target = process.argv[2] || ".env";
let content = await readFile(target, "utf8");
const environment = parseEnv(content);
const generated = [];
for (const [name, existing] of secretAssignments) {
  if (environment[name]?.trim()) continue;
  const assignment = `${name}=${randomBytes(32).toString("base64url")}`;
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
