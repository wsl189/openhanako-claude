import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 10_000,
    exclude: [
      "**/node_modules/**",
      "**/.research/**",
      "**/dist/**",
      "**/*.app/**",
      "**/*-unpacked/**",
    ],
  },
});
