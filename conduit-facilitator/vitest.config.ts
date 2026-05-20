import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // setup.ts sets the env vars config.ts validates at import time, so
    // importing any module that pulls in config/chain doesn't exit the runner.
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
