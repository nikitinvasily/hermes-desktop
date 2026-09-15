import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer/src"),
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    passWithNoTests: true,
    setupFiles: ["./src/renderer/src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
    // Node 22+ ships an experimental core localStorage that is `undefined`
    // unless --localstorage-file is passed, and it SHADOWS the jsdom global in
    // the test worker: every `localStorage.clear()` then throws "Cannot read
    // properties of undefined". Disable Node's webstorage so jsdom's own
    // localStorage implementation wins inside the test environment.
    execArgv: ["--no-experimental-webstorage"],
  },
});
