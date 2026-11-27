import { describe, expect, it } from "vite-plus/test";

import {
  isDiagnosticCategory,
  isDiscoverySource,
  isOperationCategory,
  isProviderFailureClass,
} from "../src/contracts";

describe.each([
  ["isDiscoverySource", isDiscoverySource, ["github", "prefer_not_to_say"]],
  ["isDiagnosticCategory", isDiagnosticCategory, ["unhandled_exception", "client_exception"]],
  ["isOperationCategory", isOperationCategory, ["publish", "other"]],
  ["isProviderFailureClass", isProviderFailureClass, ["ambiguous", "transient"]],
])("%s", (_name, guard, members) => {
  it.each(members)("the member %s", (member) => {
    expect(guard(member)).toEqual(true);
  });

  it.each([
    ["an unknown string", "somewhere else"],
    ["an empty string", ""],
    ["a number", 0],
    ["a null value", null],
    ["a list of members", members],
  ])("%s", (_example, value) => {
    expect(guard(value)).toEqual(false);
  });
});
