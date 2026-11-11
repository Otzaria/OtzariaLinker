import base from "./vite.config.ts";

/*
 * The real-data validation (tests/validation, docs/validation/REAL_DATA_REPORT.md). Separate from
 * `npm test`: every file there is skipped without OTZARIA_DB / OTZARIA_LIBRARY / OTZARIA_EXTRA_DBS,
 * and a full run reads a 4.5 GB database for many minutes. One file at a time, to bound memory.
 *   npm run validate:real
 */
export default {
  ...base,
  test: {
    ...base.test,
    include: ["tests/validation/**/*.test.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    fileParallelism: false,
  },
};
