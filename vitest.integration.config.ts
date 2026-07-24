import base from "./vitest.config";

export default {
  ...base,
  test: {
    ...base.test,
    include: [
      "packages/**/test/**/*.integration.test.ts",
      "apps/**/test/**/*.integration.test.ts",
    ],
    exclude: [],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
};
