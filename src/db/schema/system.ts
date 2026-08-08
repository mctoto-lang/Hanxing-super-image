import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import { enterprises } from "./enterprise"

/**
 * 系统设置（手册 §4.4、M7）
 *
 * - key 全局唯一：平台级配置（如 storage_backend、queue_threshold）；
 * - enterpriseId NULL = 平台级；非 NULL = 企业级覆盖。
 */
export interface SystemSettingValue {
  value: unknown
  [key: string]: unknown
}

export const systemSettings = pgTable(
  "system_setting",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id").references(() => enterprises.id, {
      onDelete: "cascade",
    }), // NULL = 平台级
    key: varchar("key", { length: 100 }).notNull(),
    value: jsonb("value").$type<SystemSettingValue>().notNull(),
    description: text("description"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("setting_key_ent_unique").on(t.key, t.enterpriseId),
    index("setting_ent").on(t.enterpriseId),
  ],
)
