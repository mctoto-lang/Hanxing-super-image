import {
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { enterprises } from "./enterprise"

/**
 * 服务可用性采样（侧边栏「服务状态检测」弹窗 / uptime 历史条）
 *
 * - platform 级服务（storage/postgres）：enterpriseId 为 NULL；
 *   企业级服务（chat/ai/ps-api）：按企业隔离。
 * - 采样槽对齐 5 分钟（检测间隔统一 5 分钟）：同一槽内反复采样
 *   upsert 覆盖为最新状态；弹窗展示最近 30 个槽（约 2.5 小时）。
 * - 唯一约束 NULLS NOT DISTINCT：platform 行 enterpriseId 为 NULL 时
 *   upsert 冲突检测仍生效（Postgres 默认 NULL 互不相等，无法命中冲突）。
 */
export const serviceStatusSamples = pgTable(
  "service_status_sample",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 服务类型："chat" | "ai" | "ps-api" | "storage" | "postgres" */
    serviceType: varchar("service_type", { length: 32 }).notNull(),
    /** NULL = 平台级（storage/postgres）；企业级服务按企业隔离 */
    enterpriseId: uuid("enterprise_id").references(() => enterprises.id, {
      onDelete: "cascade",
    }),
    /** 采样槽（UTC，对齐整 5 分钟），如 2026-09-07T10:35:00Z */
    slot: timestamp("slot", { withTimezone: true }).notNull(),
    /** operational | degraded | down */
    status: varchar("status", { length: 16 }).notNull(),
    /** 探测延迟（毫秒）；不可达时为 NULL */
    latencyMs: integer("latency_ms"),
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("status_sample_unique")
      .on(t.serviceType, t.enterpriseId, t.slot)
      .nullsNotDistinct(),
    index("status_sample_lookup").on(t.enterpriseId, t.serviceType, t.slot),
  ],
)
