import path from "node:path";

const rolloutPercentPattern = /^(?:5|25|50|100)$/;

const definitions = {
  cron: {
    boolean: new Set(["apply", "help"]),
    repeatable: new Set(["approval-metadata"]),
    value: new Set(["confirm", "iac-outputs", "input", "out-dir", "phase", "plan-digest"]),
  },
  deploy: {
    boolean: new Set(["apply", "help"]),
    repeatable: new Set(["approval-metadata"]),
    value: new Set([
      "confirm",
      "iac-outputs",
      "input",
      "out-dir",
      "percentage",
      "phase",
      "plan-digest",
      "step",
    ]),
  },
  manifest: {
    boolean: new Set(["help"]),
    repeatable: new Set(["approval-metadata"]),
    value: new Set(["iac-outputs", "input", "out-dir"]),
  },
  migrate: {
    boolean: new Set(["apply", "help"]),
    repeatable: new Set(["approval-metadata"]),
    value: new Set(["confirm", "input", "out-dir", "phase", "plan-digest"]),
  },
  preflight: {
    boolean: new Set(["offline", "help"]),
    repeatable: new Set(),
    value: new Set(["input", "out-dir"]),
  },
  render: {
    boolean: new Set(["help"]),
    repeatable: new Set(),
    value: new Set(["iac-outputs", "input", "out-dir"]),
  },
  "restore-point": {
    boolean: new Set(["apply", "help"]),
    repeatable: new Set(["approval-metadata"]),
    value: new Set(["confirm", "iac-outputs", "input", "out-dir", "plan-digest"]),
  },
  secrets: {
    boolean: new Set(["apply", "help"]),
    repeatable: new Set(["approval-metadata"]),
    value: new Set(["confirm", "iac-outputs", "input", "out-dir", "phase", "plan-digest"]),
  },
  smoke: {
    boolean: new Set(["help"]),
    repeatable: new Set(),
    value: new Set(["iac-outputs", "input", "out-dir", "percentage", "phase"]),
  },
};

function environmentValue(values, name, environmentName, environment) {
  return values.get(name) ?? environment[environmentName];
}

export function releaseUsage(command) {
  const definition = definitions[command];
  if (!definition) {
    throw new TypeError(`unknown release command: ${command ?? "(missing)"}`);
  }
  const flags = [
    ...[...definition.boolean].map((name) => `--${name}`),
    ...[...definition.repeatable].map((name) => `--${name} <${name}>...`),
    ...[...definition.value].map((name) => `--${name} <${name}>`),
  ];
  return `${command}${flags.length > 0 ? " " : ""}${flags.join(" ")}`;
}

export function parseReleaseArguments(argv, environment) {
  const [command, ...rest] = argv;
  const definition = definitions[command];
  if (!definition) {
    throw new TypeError(`unknown release command: ${command ?? "(missing)"}`);
  }
  const values = new Map();
  const booleans = new Set();
  const repeated = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) throw new TypeError(`unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (definition.boolean.has(name)) {
      if (booleans.has(name)) throw new TypeError(`${argument} may be specified only once`);
      booleans.add(name);
      continue;
    }
    if (!definition.value.has(name) && !definition.repeatable.has(name)) {
      throw new TypeError(`unknown option for ${command}: ${argument}`);
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
    if (definition.repeatable.has(name)) {
      repeated.set(name, [...(repeated.get(name) ?? []), value]);
    } else {
      if (values.has(name)) throw new TypeError(`${argument} may be specified only once`);
      values.set(name, value);
    }
    index += 1;
  }

  if (booleans.has("help")) {
    return { command, help: true };
  }

  const input = environmentValue(values, "input", "MELTIPLY_RELEASE_INPUT", environment);
  if (!input) throw new TypeError("--input or MELTIPLY_RELEASE_INPUT is required");
  const iacOutputs = environmentValue(
    values,
    "iac-outputs",
    "MELTIPLY_RELEASE_IAC_OUTPUTS",
    environment,
  );
  if (
    new Set(["cron", "deploy", "manifest", "render", "restore-point", "secrets", "smoke"]).has(
      command,
    ) &&
    !iacOutputs
  ) {
    throw new TypeError("--iac-outputs or MELTIPLY_RELEASE_IAC_OUTPUTS is required");
  }

  const percentageSource = values.get("percentage");
  let percentage;
  if (percentageSource !== undefined) {
    if (!rolloutPercentPattern.test(percentageSource)) {
      throw new TypeError("--percentage must be 5, 25, 50, or 100");
    }
    percentage = Number(percentageSource);
  }
  const environmentApproval = environment.MELTIPLY_RELEASE_APPROVAL_METADATA;
  const approvalMetadata = [
    ...(repeated.get("approval-metadata") ?? []),
    ...(environmentApproval ? [environmentApproval] : []),
  ].map((value) => path.resolve(value));

  return {
    apply: booleans.has("apply"),
    approvalMetadata,
    command,
    confirm: values.get("confirm"),
    iacOutputsPath: iacOutputs ? path.resolve(iacOutputs) : undefined,
    inputPath: path.resolve(input),
    offline: booleans.has("offline"),
    outDir: path.resolve(
      environmentValue(values, "out-dir", "MELTIPLY_RELEASE_DIR", environment) ?? ".release",
    ),
    percentage,
    phase: values.get("phase"),
    planDigest: environmentValue(
      values,
      "plan-digest",
      "MELTIPLY_RELEASE_PLAN_DIGEST",
      environment,
    ),
    step: values.get("step"),
  };
}
