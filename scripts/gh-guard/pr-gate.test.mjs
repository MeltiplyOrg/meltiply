/**
 * Regression suite for the Meltiply PR gate.
 *
 * Covers the three consumer-visible surfaces of the gate as subprocesses
 * (plus the renderer module for schema-level rejection):
 *
 *   * scripts/gh-guard/pr-body.mjs — `preparePullRequest(input)` takes the
 *     untrusted parsed JSON object, enforces pr.schema.json, parses every
 *     Mermaid diagram (including ```mermaid fences embedded in section
 *     Markdown), requires a visible added/removed diff in Summary, checks
 *     headings/comments and unclosed fences, Vite+-formats the body,
 *     spell-checks title+body with the real `typos` binary, and resolves to
 *     `{ title, body }`.
 *   * scripts/gh-guard/pr.mjs — the CLI. `check <file>|-` validates without
 *     emitting Markdown; `render <file>|-` prints the canonical body on
 *     stdout. Validation failures exit 1; usage/input failures exit 2.
 *   * scripts/gh-guard/gh — the PATH-shadow guard. `gh pr create` accepts
 *     only `--body-json <file>|-` / `--body-json=<file>` for body input,
 *     and hands the real gh `pr create <flags> --title <json title>
 *     --body-file -` with the GENERATED body on stdin. Body/title/template
 *     flags and bundled short forms are rejected before any GitHub access.
 *
 * A synthetic recording binary installed through MELTIPLY_REAL_GH is the
 * sole external side-effect seam: it proves invalid input never crosses
 * into a real PR creation and captures the exact argv/stdin a valid create
 * delivers. All fixtures are synthetic objects built in this file; no
 * network, GitHub, git state, or repository file is touched. The misspelled
 * fixture token is assembled at runtime so this file itself stays clean
 * under `.typos.toml`. Run standalone via:
 *
 *   node --test scripts/gh-guard/pr-gate.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { preparePullRequest } from "./pr-body.mjs";

const cliPath = fileURLToPath(new URL("./pr.mjs", import.meta.url));
const guardPath = fileURLToPath(new URL("./gh", import.meta.url));

// Sandboxed workspace for JSON fixtures, the recording gh surrogates, and
// the controlled-PATH tool directory. Removed wholesale on suite exit.
const sandbox = mkdtempSync(join(tmpdir(), "meltiply-pr-gate-test-"));
after(() => rmSync(sandbox, { recursive: true, force: true }));

let fixtureCounter = 0;

/**
 * Writes a JSON fixture to a uniquely named file inside the sandbox and
 * returns its absolute path. Each call gets a fresh name so files are never
 * mutated out from under an earlier spawn.
 */
function writeJsonFile(value) {
  fixtureCounter += 1;
  const file = join(sandbox, `pr-input-${fixtureCounter}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

/**
 * Runs `node scripts/gh-guard/pr.mjs <args>` and returns the raw spawnSync
 * result. `input` is piped on stdin for the `-` file form.
 */
function runCli(args, { input } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    input,
    encoding: "utf8",
  });
}

/**
 * Formats a subprocess result for assertion messages so a failing verdict
 * surfaces the program's own diagnostics rather than a bare exit code.
 */
function describeRun(result) {
  const stderr = (result.stderr ?? "").toString().trim();
  const stdout = (result.stdout ?? "").toString().trim().slice(0, 400);
  return `status=${result.status} signal=${result.signal} ` + `stderr=${stderr} stdout=${stdout}`;
}

/**
 * Runs the PATH-shadow guard with a recording gh surrogate installed as the
 * real-gh boundary via MELTIPLY_REAL_GH. `input` feeds the guard's stdin
 * (the `--body-json -` channel); `pathOverride` replaces PATH entirely for
 * the missing-checker fail-closed case.
 */
function runGuard(args, { input, surrogate, pathOverride } = {}) {
  const env = pathOverride
    ? { PATH: pathOverride, MELTIPLY_REAL_GH: surrogate }
    : { ...process.env, MELTIPLY_REAL_GH: surrogate };
  return spawnSync(guardPath, args, { input, encoding: "utf8", env });
}

/**
 * Installs the synthetic gh surrogate inside the sandbox and returns its
 * recording paths. The surrogate is the external side-effect boundary of
 * the guard: it touches an `invoked` marker first (so reachability is
 * provable even if a later write crashes), records each received argv entry
 * on its own line (title/body entries may themselves contain spaces), and
 * copies whatever arrives on stdin verbatim.
 */
function installRecordingSurrogate(name) {
  const dir = join(sandbox, name.replace(/\W+/g, "-"));
  mkdirSync(dir, { recursive: true });
  const invoked = join(dir, "invoked");
  const argv = join(dir, "argv");
  const stdin = join(dir, "stdin");
  const surrogate = join(dir, "gh");
  writeFileSync(
    surrogate,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `record_dir=${JSON.stringify(dir)}`,
      ': > "$record_dir/invoked"',
      ': > "$record_dir/argv"',
      'for a in "$@"; do printf "%s\\n" "$a" >> "$record_dir/argv"; done',
      'cat > "$record_dir/stdin"',
      "",
    ].join("\n"),
  );
  chmodSync(surrogate, 0o755);
  return { invoked, argv, stdin, surrogate };
}

/**
 * Reads a surrogate recording channel, tolerating a recording left
 * half-written by a crashed surrogate.
 */
function readRecording(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
 * Splits the surrogate's argv recording into the original argument list;
 * an empty recording means the surrogate received no arguments.
 */
function recordedArgv(file) {
  const raw = readRecording(file);
  return raw === "" ? [] : raw.replace(/\n$/, "").split("\n");
}

// The typo used to prove the real `typos` binary gates PR bodies is
// assembled at runtime so the repo spell checker never sees a literal
// misspelling in this file.
const typoToken = ["sepe", "rate"].join("");

const baseDiagram = {
  section: "summary",
  source:
    "flowchart LR\n" +
    '  agent["agent"] -->|"create"| guard["gh-guard"]\n' +
    '  guard -->|"valid"| gh["real gh"]\n' +
    '  guard -->|"invalid"| blocked["blocked"]\n',
};

/**
 * Returns a synthetic PR input satisfying schema and downstream gates: all
 * section keys, a visible added/removed diff, valid Mermaid, and acknowledged
 * agent metadata. `mutate` breaks one rule without changing other constraints
 * so rejection cases identify the intended consumer-visible validation.
 */
function validInput(mutate) {
  const input = {
    title: "test: synthetic pr gate regression fixture",
    sections: {
      summary:
        "Adds a synthetic gate fixture so the review pipeline renders an\n" +
        "end-to-end body. Nothing outside this fixture changes.\n\n" +
        "### Added / removed\n\n```diff\n+ Synthetic PR gate regression fixture\n```",
      evidence:
        "**Before:** `node --test scripts/gh-guard/pr-gate.test.mjs` " +
        "reported no such file.\n\n" +
        "**After:** the command exits 0; every case uses synthetic input.",
      mergeDanger:
        "**Door:** one-way — reverting deletes the test file.\n\n" +
        "**Blast Radius:** `scripts/gh-guard/pr-gate.test.mjs` and its\n" +
        "tmpdir sandbox; no runtime code or user state.",
      qa:
        "1. [ ] Run `node --test scripts/gh-guard/pr-gate.test.mjs`; " +
        "expect exit 0.\n" +
        "2. [ ] Confirm blocked fixtures never record a surrogate run.",
    },
    diagrams: [{ ...baseDiagram }],
    agent: {
      tool: "prgate-test-tool",
      version: "0.0.0-test.0",
      model: "synthetic pr gate model",
      readAgents: true,
    },
  };
  mutate?.(input);
  return input;
}

const validJson = JSON.stringify(validInput());

/**
 * Asserts the shared identity contract of a rendered body: the four
 * canonical H1 sections in order, the exact AGENTS.md acknowledgement, the
 * diagram embedded as a Mermaid fence, and a plain tool/model footer as
 * the last line. Used by module, render, and guard tests so all surfaces
 * are checked against one definition of "canonical".
 */
function assertCanonicalBody(body) {
  for (const heading of ["# Summary", "# Evidence", "# Merge Danger", "# QA"]) {
    assert.match(body, new RegExp(`^${heading}$`, "m"), `missing canonical heading ${heading}`);
  }
  const positions = [
    "# Summary",
    "# Evidence",
    "# Merge Danger",
    "# QA",
    "- [x] Read `AGENTS.md`",
    "PR created using",
  ].map((token) => body.indexOf(token));
  assert.ok(
    positions.every((pos, index) => pos !== -1 && (index === 0 || pos > positions[index - 1])),
    "sections, acknowledgement, and footer must appear in canonical order",
  );
  assert.match(body, /```mermaid\nflowchart LR/, "diagram not embedded");
  assert.match(body, /prgate-test-tool/);
  assert.match(body, /v0\.0\.0-test\.0/, "footer must render v<version>");
  assert.match(body, /synthetic pr gate model/);
  const lastLine = body.trimEnd().split("\n").at(-1);
  assert.match(lastLine, /^PR created using /, "footer must be the last line");
  assert.match(lastLine, / - model /, "footer must carry the model id");
}

describe("preparePullRequest module", () => {
  test("resolves title and canonical body for a valid input", async () => {
    const input = validInput();
    const result = await preparePullRequest(input);
    assert.equal(result.title, input.title);
    assert.equal(typeof result.body, "string");
    assertCanonicalBody(result.body);
  });

  test("accepts addition-only, removal-only, and mixed change summaries", async () => {
    for (const changes of [
      "+ New behavior",
      "- Previous behavior",
      "- Previous behavior\n\n+ New behavior",
    ]) {
      const result = await preparePullRequest(
        validInput((input) => {
          input.sections.summary = `### Added / removed\n\n\`\`\`diff\n${changes}\n\`\`\``;
          input.sections.evidence = "";
          input.sections.mergeDanger = "";
          input.sections.qa = "";
          input.diagrams = [];
        }),
      );
      assert.match(result.body, /### Added \/ removed\n\n```diff\n/);
      assert.ok(result.body.includes(changes));
    }
  });

  test("rejects missing, misplaced, or non-descriptive change diffs", async () => {
    const cases = [
      "",
      "Only prose.",
      "```diff\n+ New behavior\n```",
      "### Added / removed\n\n```text\n+ New behavior\n```",
      "### Added / removed\n\n```diff\n```",
      "### Added / removed\n\n```diff\n+\n- \n```",
      "### Added / removed\n\n```diff\n+New behavior\n```",
      "### Added / removed\n\n```diff\n+   \n```",
      "### Added / removed\n\n```diff\n+ New behavior\nUnmarked behavior\n```",
      "### Added / removed\n\n### Another section\n\n```diff\n+ New behavior\n```",
      "> ### Added / removed\n>\n> ```diff\n> + New behavior\n> ```",
      "````text\n### Added / removed\n\n```diff\n+ New behavior\n```\n````",
    ];
    for (const summary of cases) {
      await assert.rejects(
        () =>
          preparePullRequest(
            validInput((input) => {
              input.sections.summary = summary;
              input.sections.evidence += "\n\n### Added / removed\n\n```diff\n+ Evidence only\n```";
            }),
          ),
        /sections\.summary:.*(?:Added \/ removed|added\/removed diff)/,
      );
    }
  });

  test("rejects inputs that violate the schema or diagram bounds", async () => {
    const cases = {
      "missing title": (input) => {
        delete input.title;
      },
      "empty title": (input) => {
        input.title = "";
      },
      "title over 72 chars": (input) => {
        input.title = `t${"i".repeat(72)}`;
      },
      "multiline title": (input) => {
        input.title = "first\nsecond";
      },
      "missing sections key": (input) => {
        delete input.sections.qa;
      },
      "extra section key": (input) => {
        input.sections.extra = "surprise";
      },
      "section not a string": (input) => {
        input.sections.qa = ["1. [ ] step"];
      },
      "unknown top-level key": (input) => {
        input.extra = true;
      },
      "readAgents false": (input) => {
        input.agent.readAgents = false;
      },
      "version carries a v prefix": (input) => {
        input.agent.version = "v1.2.3";
      },
      "tool contains a space": (input) => {
        input.agent.tool = "not one token";
      },
      "empty model": (input) => {
        input.agent.model = "";
      },
      "missing agent key": (input) => {
        delete input.agent.model;
      },
      "diagram section outside enum": (input) => {
        input.diagrams = [{ section: "title", source: "flowchart LR\n  a --> b" }];
      },
      "empty diagram source": (input) => {
        input.diagrams = [{ section: "qa", source: "" }];
      },
      "whitespace-only diagram source": (input) => {
        input.diagrams = [{ section: "qa", source: "   \n  " }];
      },
      "diagram source over 5000 chars": (input) => {
        input.diagrams = [{ section: "qa", source: `flowchart LR\n  ${"a".repeat(5000)}` }];
      },
      "diagrams not an array": (input) => {
        input.diagrams = { section: "qa", source: "flowchart LR" };
      },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      await assert.rejects(
        () => preparePullRequest(validInput(mutate)),
        `${name} must be rejected`,
      );
    }
  });
});

describe("pr.mjs CLI", () => {
  test("check validates file and stdin inputs without emitting Markdown", () => {
    for (const [name, args, input] of [
      ["file", ["check", writeJsonFile(validInput())], undefined],
      ["stdin", ["check", "-"], validJson],
    ]) {
      const result = runCli(args, { input });
      assert.equal(result.status, 0, `${name}: ${describeRun(result)}`);
      assert.ok(
        !result.stdout.includes("# Summary"),
        `${name}: check must not emit the rendered Markdown`,
      );
    }
  });

  test("render prints the canonical body for file and stdin inputs", async () => {
    const input = validInput();
    const expected = (await preparePullRequest(input)).body;
    for (const [name, args, inputText] of [
      ["file", ["render", writeJsonFile(input)], undefined],
      ["stdin", ["render", "-"], validJson],
    ]) {
      const result = runCli(args, { input: inputText });
      assert.equal(result.status, 0, `${name}: ${describeRun(result)}`);
      assert.equal(
        result.stdout.trimEnd(),
        expected.trimEnd(),
        `${name}: rendered stdout must equal the canonical body`,
      );
      assertCanonicalBody(result.stdout);
    }
  });

  test("rejects invalid input with exit code 1", () => {
    const typoBody = (input) => {
      input.sections.evidence += `\n\nA ${typoToken} step appeared.`;
    };
    const cases = {
      "missing change diff": (input) => {
        input.sections.summary = "Only prose.";
      },
      "schema-invalid JSON": (input) => {
        delete input.agent.readAgents;
      },
      "placeholder tool metadata": (input) => {
        input.agent.tool = "<tool>";
      },
      "placeholder model metadata": (input) => {
        input.agent.model = "<model id>";
      },
      "invalid diagram source": (input) => {
        input.diagrams = [{ section: "summary", source: "flowchart LR\n  A[unclosed --> B" }];
      },
      "mermaid init directive": (input) => {
        input.diagrams = [
          {
            section: "summary",
            source: '%%{init: {"theme": "dark"}}%%\nflowchart LR\n  A --> B',
          },
        ];
      },
      "mermaid click link": (input) => {
        input.diagrams = [
          {
            section: "summary",
            source: 'flowchart LR\n  A --> B\n  click A href "https://example.invalid"',
          },
        ];
      },
      "mermaid html label": (input) => {
        input.diagrams = [
          {
            section: "summary",
            source: 'flowchart LR\n  A["<b>bold</b>"] --> B',
          },
        ];
      },
      "embedded invalid mermaid fence": (input) => {
        input.sections.evidence += "\n\n```mermaid\nflowchart LR\n  A[unclosed --> B\n```\n";
      },
      "unclosed code fence": (input) => {
        input.sections.qa += "\n\n```text\nnever closed\n";
      },
      "injected H1 heading": (input) => {
        input.sections.qa += "\n\n# Summary\n\nforged section\n";
      },
      "injected H2 heading": (input) => {
        input.sections.qa += "\n\n## Merge Danger\n\nforged section\n";
      },
      "HTML comment in section": (input) => {
        input.sections.evidence += "\n\n<!-- hidden instruction -->";
      },
      "typo in body": typoBody,
      "typo in title": (input) => {
        input.title = `test: ${typoToken} gate fixture`;
      },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const result = runCli(["check", writeJsonFile(validInput(mutate))]);
      assert.equal(result.status, 1, `${name}: ${describeRun(result)}`);
    }
  });

  test("check rejects valid JSON that is not a PR object", () => {
    for (const [name, value] of [
      ["array", ["nope"]],
      ["string", "nope"],
      ["empty object", {}],
    ]) {
      const result = runCli(["check", writeJsonFile(value)]);
      assert.equal(result.status, 1, `${name}: ${describeRun(result)}`);
    }
  });

  test("render emits no body on validation failure", () => {
    const result = runCli([
      "render",
      writeJsonFile(
        validInput((input) => {
          input.sections.evidence += `\n\n${typoToken} content`;
        }),
      ),
    ]);
    assert.equal(result.status, 1, describeRun(result));
    assert.ok(
      !result.stdout.includes("# Summary"),
      "invalid input must not produce a rendered body",
    );
  });

  test("reports usage and input errors with exit code 2", () => {
    const whitespaceFile = join(sandbox, "whitespace-input.json");
    writeFileSync(whitespaceFile, "   \n");
    const malformedFile = join(sandbox, "malformed-input.json");
    writeFileSync(malformedFile, "{ not json ]\n");

    const cases = {
      "no arguments": { args: [] },
      "unknown subcommand": { args: ["frob", writeJsonFile(validInput())] },
      "check without a file": { args: ["check"] },
      "render without a file": { args: ["render"] },
      "too many arguments": {
        args: ["check", writeJsonFile(validInput()), writeJsonFile(validInput())],
      },
      "input file does not exist": {
        args: ["check", join(sandbox, "no-such-input.json")],
      },
      "malformed JSON file": { args: ["check", malformedFile] },
      "whitespace-only input file": { args: ["check", whitespaceFile] },
      "malformed JSON on stdin": { args: ["check", "-"], input: "{ nope ]" },
      "empty stdin": { args: ["check", "-"], input: "" },
    };
    for (const [name, { args, input }] of Object.entries(cases)) {
      const result = runCli(args, { input });
      assert.equal(result.status, 2, `${name}: ${describeRun(result)}`);
    }
  });

  test("render normalizes formatting in section Markdown", () => {
    const input = validInput((draft) => {
      draft.sections.evidence =
        "**Before:** the suite was missing.\n\n\n\n\n" + "**After:** every check passes.";
      draft.sections.qa = "1. [ ]   run the suite\n1. [ ]   confirm output";
    });
    const result = runCli(["render", writeJsonFile(input)]);
    assert.equal(result.status, 0, describeRun(result));
    assert.ok(
      !result.stdout.includes("\n\n\n"),
      "collapsed blank-line runs must not survive formatting",
    );
    assert.ok(!result.stdout.includes("   run the suite"), "list spacing must be normalized");
    assert.ok(result.stdout.includes("run the suite"));
  });
});

describe("gh-guard fail-closed boundary", () => {
  /**
   * Spawns `gh <args>` with a fresh recording surrogate and returns the
   * spawn result plus the recording paths for assertions.
   */
  function guarded(args, { input, name, pathOverride } = {}) {
    const recording = installRecordingSurrogate(name);
    const result = runGuard(args, {
      input,
      surrogate: recording.surrogate,
      pathOverride,
    });
    return { result, recording };
  }

  /**
   * Asserts a `gh pr create` invocation was stopped at the gate: the guard
   * exits nonzero and the surrogate's invoked marker never appears, proving
   * the real-gh boundary was never crossed.
   */
  function assertCreateBlocked(args, { input, name } = {}) {
    const { result, recording } = guarded(args, {
      input,
      name: name ?? `blocked-${(fixtureCounter += 1)}`,
    });
    assert.notEqual(result.status, 0, describeRun(result));
    assert.equal(
      existsSync(recording.invoked),
      false,
      `surrogate was invoked despite blocked input: ${args.join(" ")}`,
    );
    return result;
  }

  /**
   * Asserts a valid `gh pr create` reached the real gh with the guard-
   * generated payload: forwarded argv is `pr create` plus the caller's
   * ordinary flags, `--title` taken from the JSON, and `--body-file -`
   * carrying the exact rendered canonical body on stdin. The raw
   * `--body-json` input flag must not survive to the real gh.
   */
  function assertCreateDelivers(args, { input, name, expectedBody }) {
    const { result, recording } = guarded(args, { input, name });
    assert.equal(result.status, 0, describeRun(result));
    assert.equal(
      existsSync(recording.invoked),
      true,
      `surrogate was never invoked: ${args.join(" ")}`,
    );

    const argv = recordedArgv(recording.argv);
    assert.deepEqual(
      argv.slice(0, 2),
      ["pr", "create"],
      "real gh must receive a pr create invocation",
    );
    const titleIndex = argv.indexOf("--title");
    assert.notEqual(titleIndex, -1, "forwarded argv must carry --title");
    assert.equal(
      argv[titleIndex + 1],
      "test: synthetic pr gate regression fixture",
      "forwarded title must come from the JSON input",
    );
    const bodyFileIndex = argv.indexOf("--body-file");
    assert.notEqual(bodyFileIndex, -1, "forwarded argv must carry --body-file");
    assert.equal(argv[bodyFileIndex + 1], "-", "generated body must be piped via --body-file -");
    assert.ok(argv.includes("--draft"), "ordinary creation flags must pass through");
    assert.ok(
      !argv.some((entry) => entry === "--body-json" || entry.startsWith("--body-json=")),
      "the raw --body-json input flag must not reach the real gh",
    );
    assert.equal(
      readRecording(recording.stdin),
      expectedBody,
      "the real gh stdin must be the exact rendered canonical body",
    );
    return argv;
  }

  test("forwards a file-based create with the exact generated body", async () => {
    const input = validInput();
    const expectedBody = (await preparePullRequest(input)).body;
    const argv = assertCreateDelivers(
      [
        "pr",
        "create",
        "--body-json",
        writeJsonFile(input),
        "--draft",
        "--repo",
        "example/repo",
        "--label",
        "agent",
      ],
      { name: "create-file", expectedBody },
    );
    assert.equal(
      argv[argv.indexOf("--repo") + 1],
      "example/repo",
      "value-taking flags must keep their values",
    );
    assert.equal(argv[argv.indexOf("--label") + 1], "agent");
  });

  test("forwards stdin JSON creates for both --body-json forms", async () => {
    const expectedBody = (await preparePullRequest(validInput())).body;
    for (const [name, args] of [
      ["create-stdin-space", ["pr", "create", "--body-json", "-", "--draft"]],
      ["create-stdin-equals", ["pr", "create", "--body-json=-", "--draft"]],
    ]) {
      // Trailing newlines on the JSON stream exercise the consume-and-replay
      // handoff: the real gh must still get the full rendered body, not the
      // truncated or doubly-consumed input.
      assertCreateDelivers(args, {
        input: `${validJson}\n\n`,
        name,
        expectedBody,
      });
    }
  });

  test("blocks creates whose input fails schema, diagram, or spell checks", () => {
    const schemaInvalid = writeJsonFile(
      validInput((input) => {
        input.agent.readAgents = false;
      }),
    );
    const diagramInvalid = writeJsonFile(
      validInput((input) => {
        input.diagrams = [{ section: "summary", source: "flowchart LR\n  A[unclosed --> B" }];
      }),
    );
    const typoInvalid = writeJsonFile(
      validInput((input) => {
        input.sections.qa += `\nA ${typoToken} step.`;
      }),
    );
    const malformed = join(sandbox, "guard-malformed.json");
    writeFileSync(malformed, "{ not json ]");

    for (const [name, args, input] of [
      [
        "missing-diff",
        [
          "pr",
          "create",
          "--body-json",
          writeJsonFile(
            validInput((input) => {
              input.sections.summary = "Only prose.";
            }),
          ),
        ],
        undefined,
      ],
      ["schema", ["pr", "create", "--body-json", schemaInvalid], undefined],
      ["diagram", ["pr", "create", "--body-json", diagramInvalid], undefined],
      ["typo", ["pr", "create", "--body-json", typoInvalid], undefined],
      ["malformed", ["pr", "create", "--body-json", malformed], undefined],
      ["bad-stdin", ["pr", "create", "--body-json", "-"], "{ nope ]"],
    ]) {
      assertCreateBlocked(args, { input, name: `create-${name}` });
    }
  });

  test("blocks direct body channels, hidden bodies, and missing input", () => {
    const bodyFile = join(sandbox, "direct-body.md");
    writeFileSync(bodyFile, "# Summary\n\nbypass attempt\n");
    const jsonFile = writeJsonFile(validInput());
    const cases = {
      "--body value": ["pr", "create", "--body", "hand-written body"],
      "--body=value": ["pr", "create", "--body=hand-written body"],
      "-b value": ["pr", "create", "-b", "hand-written body"],
      "--body-file": ["pr", "create", "--body-file", bodyFile],
      "-F file": ["pr", "create", "-F", bodyFile],
      "--title": ["pr", "create", "--title", "hand-written"],
      "-t": ["pr", "create", "-t", "hand-written"],
      "--fill": ["pr", "create", "--fill"],
      "-f": ["pr", "create", "-f"],
      "--fill-first": ["pr", "create", "--fill-first"],
      "--template": ["pr", "create", "--template", "feature.md"],
      "-T": ["pr", "create", "-T", "feature.md"],
      "--recover": ["pr", "create", "--recover"],
      "--editor": ["pr", "create", "--editor"],
      "--web": ["pr", "create", "--web"],
      "bundled -dF": ["pr", "create", "-dF", bodyFile],
      "bundled -df": ["pr", "create", "-df"],
      "--body-json plus --body": ["pr", "create", "--body-json", jsonFile, "--body", "sneaky"],
      "no body channel": ["pr", "create", "--draft"],
      "duplicate --body-json": ["pr", "create", "--body-json", jsonFile, "--body-json", jsonFile],
      "--body-json missing value": ["pr", "create", "--body-json"],
      "empty --body-json=": ["pr", "create", "--body-json="],
      "missing body-json file": ["pr", "create", "--body-json", join(sandbox, "absent-input.json")],
      "bare positional argument": ["pr", "create", "mystery"],
    };
    for (const [name, args] of Object.entries(cases)) {
      assertCreateBlocked(args, { name: `hidden-${name}` });
    }
  });

  test("fails closed when the spell checker is unavailable", () => {
    // A controlled PATH exposes only the tools a gate implementation may
    // legitimately need; the real `typos` binary is deliberately absent so
    // the missing checker must fail closed rather than skip the check.
    const toolsDir = join(sandbox, "controlled-path");
    mkdirSync(toolsDir, { recursive: true });
    const needed = ["bash", "dirname"];
    const resolved = spawnSync(
      "bash",
      [
        "-c",
        `for n in ${needed.join(" ")}; do ` +
          'p="$(command -v "$n" 2>/dev/null)" && printf "%s=%s\\n" "$n" "$p"; ' +
          "done",
      ],
      { encoding: "utf8" },
    );
    assert.equal(resolved.status, 0, "could not resolve core tools");
    for (const line of resolved.stdout.trim().split("\n")) {
      const [toolName, toolPath] = line.split("=");
      if (toolPath?.startsWith("/")) {
        symlinkSync(toolPath, join(toolsDir, toolName));
      }
    }
    symlinkSync(process.execPath, join(toolsDir, "node"));

    const { result, recording } = guarded(
      ["pr", "create", "--body-json", writeJsonFile(validInput())],
      { name: "missing-checker", pathOverride: toolsDir },
    );
    assert.notEqual(
      result.status,
      0,
      `gate must fail closed without the spell checker: ${describeRun(result)}`,
    );
    assert.match(
      result.stderr,
      /Typo check unavailable:.*ENOENT/,
      `failure must identify the missing checker: ${describeRun(result)}`,
    );
    assert.equal(
      existsSync(recording.invoked),
      false,
      "real gh must not run when a required checker is missing",
    );
  });
});
