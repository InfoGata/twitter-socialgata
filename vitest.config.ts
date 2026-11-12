import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Nitter parser runs on DOMParser documents.
    environment: "jsdom",
    include: ["src/test/**/*.test.ts"],
  },
});
