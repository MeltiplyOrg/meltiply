import { request } from "node:http";

const [action = "status", argument, extra] = process.argv.slice(2);
let command;
if (action === "status") command = { action };
else if (action === "token") command = { action, email: argument, subject: extra || argument };
else if (action === "replay")
  command = { action, queue: argument, limit: extra ? Number(extra) : 100 };
else if (["probe-write", "probe-read"].includes(action))
  command = { action, id: argument, organizationId: extra };
else
  throw new TypeError(
    "Usage: admin.mjs status | token EMAIL [SUBJECT] | replay DLQ [LIMIT] | probe-write UUID ORG_UUID | probe-read UUID ORG_UUID",
  );
const body = JSON.stringify(command);
const result = await new Promise((resolve, reject) => {
  const connection = request(
    {
      socketPath: "/tmp/meltiply-admin.sock",
      path: "/",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    },
    (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () =>
        response.statusCode === 200 ? resolve(text) : reject(new Error(text)),
      );
      response.on("error", reject);
    },
  );
  connection.setTimeout(90000, () =>
    connection.destroy(new Error("Administration command timed out")),
  );
  connection.on("error", reject);
  connection.end(body);
});
console.log(result);
