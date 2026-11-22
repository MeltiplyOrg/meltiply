import { packageTestConfig } from "../../scripts/lib/package-test-config";

export default packageTestConfig(
  { branches: 70, functions: 80, lines: 75, statements: 75 },
  {
    coverageExclude: ["src/service.ts"],
  },
);
