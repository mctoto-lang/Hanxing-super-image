import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

/**
 * Vitest 配置（手册 §10.6）
 *
 * 测试连接真实的 PG/Redis（docker-compose.dev.yml 起的本地容器）。
 * 并发扣减测试用一个独立测试库 hanxing_super_test 隔离。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/__tests__/setup.ts"],
    // 并发扣减测试需要真实并发（forks 池）
    pool: "forks",
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
})
