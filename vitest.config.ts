import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 単体テストは純粋関数のみを対象とする（§2）。
// src 配下には `import "server-only"` を含むモジュールがあるため、
// server-only を空モジュールにエイリアスして node 環境で import 可能にする。
export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./tests/unit/stubs/server-only.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
