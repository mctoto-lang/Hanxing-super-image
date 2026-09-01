import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"

/**
 * 广告横幅（超管配置，登录后全站轮换展示）
 *
 * - 平台级配置，不区分企业：所有登录用户可见（营销页/登录页不展示）
 * - 多条同时生效时由服务端随机取一条展示（轮换）
 * - startsAt/endsAt 为投放周期窗口（NULL = 不限）；
 *   countdownEndsAt 到期后横幅自动下线（促销语义：活动结束即撤下）
 */
export const banners = pgTable(
  "banner",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: varchar("title", { length: 100 }).notNull(),
    content: varchar("content", { length: 300 }).notNull(),
    linkUrl: text("link_url"), // 站外跳转链接（http/https，NULL = 纯展示）
    linkLabel: varchar("link_label", { length: 50 })
      .notNull()
      .default("立即查看"),
    icon: varchar("icon", { length: 50 }).notNull().default("megaphone"), // 白名单见 lib/banner
    countdownEndsAt: timestamp("countdown_ends_at", { withTimezone: true }), // NULL = 无倒计时
    startsAt: timestamp("starts_at", { withTimezone: true }), // NULL = 立即投放
    endsAt: timestamp("ends_at", { withTimezone: true }), // NULL = 长期投放
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("banner_active").on(t.isActive, t.sortOrder)],
)
