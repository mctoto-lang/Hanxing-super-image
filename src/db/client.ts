import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { env } from "@/lib/env"
import * as schema from "@/db/schema"

/**
 * Drizzle 客户端单例（手册 §3、§4）
 *
 * 使用 postgres-js 驱动（轻量、支持 prepare），全量加载 schema
 * 以便关系查询可直接链式访问。
 */
const globalForDb = globalThis as unknown as {
  __db?: ReturnType<typeof createDb>
}

function createDb() {
  const client = postgres(env.DATABASE_URL, {
    // 池上限经 DB_POOL_MAX 可调（默认 10）：多 worker 副本时每进程按需调大
    max: env.DB_POOL_MAX,
    prepare: false, // drizzle-orm/postgres-js 在事务场景下推荐关闭
  })
  return drizzle({ client, schema })
}

export const db = globalForDb.__db ?? createDb()

if (process.env.NODE_ENV !== "production") {
  globalForDb.__db = db
}

export type DB = typeof db
