import { defineConfig } from "drizzle-kit"
import { env } from "@/lib/env"

/**
 * drizzle-kit 配置（手册 §2.1、§3）
 *
 * schema 按域拆分到 src/db/schema/，统一从 index.ts 汇总导出。
 * 迁移产物输出到 drizzle/ 目录。
 */
export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
  verbose: true,
  strict: true,
})
