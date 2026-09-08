import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"

/**
 * 商品主图 V2（四 tab 产品族：商品套图 / A+详情页 / 爆款复刻 / 产品精修）
 *
 * 旧三层模板体系（模板组/主模板/子模板）与图片库已彻底下线，
 * 「方向 + 提示词」成为主数据，由超管平台配置（平台级，无企业维度）。
 * 生图任务沿用 generationTasks（source="product"），套图上下文走 templateInfo。
 */

/** 方向适用子功能（replicate 无方向池，走复刻程度二选一） */
export const PRODUCT_DIRECTION_SCOPES = [
  "suite",
  "detail",
  "refine",
  "weartry", // 穿戴图片-服装组图（作用域仅数据层共享，超管两端配置页各自过滤展示）
] as const
export type ProductDirectionScope = (typeof PRODUCT_DIRECTION_SCOPES)[number]

/** 尺寸规范适用子功能 */
export const PRODUCT_SIZE_SPEC_SCOPES = ["suite", "detail"] as const
export type ProductSizeSpecScope = (typeof PRODUCT_SIZE_SPEC_SCOPES)[number]

/**
 * 图片方向（超管配置）
 *
 * 套图/A+详情页的「可选择方向」池（首屏主视觉/核心卖点图/…）
 * 与精修的「快捷优化项」（画质类）共用此表，按 appliesTo 过滤。
 */
export const productDirections = pgTable(
  "product_direction",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 稳定标识（提交校验与 templateInfo.directionKey 用） */
    key: varchar("key", { length: 60 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    /** 卡片副文案（如「传递核心价值」） */
    description: varchar("description", { length: 200 }),
    /** 生图提示词模板，支持 {{productName}}/{{sellingPoints}}/{{language}} 等变量 */
    promptTemplate: text("prompt_template").notNull(),
    /**
     * 适用子功能（单选：suite=商品套图 detail=A+详情页 refine=产品精修）。
     * 三个分类页配置彻底隔开：每行恰属一个作用域（0023 迁移拆分了存量
     * 共享行并加 CHECK 约束），元组类型在编译期防多选写入
     */
    appliesTo: jsonb("applies_to")
      .$type<[ProductDirectionScope]>()
      .default(["suite"])
      .notNull(),
    /** 是否显示数量调节（套图类 true，画质类 false） */
    supportsCount: boolean("supports_count").default(false).notNull(),
    /** 数量上限（supportsCount=true 时前端 ± 的边界） */
    maxCount: integer("max_count").default(1).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    /**
     * 前端隐藏：不显示在套图「自定义配置」手动列表；
     * 智能匹配与「其他」AI 补充的候选池不受影响（仅影响手动勾选入口）
     */
    isHidden: boolean("is_hidden").default(false).notNull(),
    /**
     * 白底图类（主图）：生图时注入所选平台的 heroPromptSegment 主图规范
     * （如 Amazon 纯白背景规则）。与 key 解耦，由超管在表单的「方向类别」选择
     */
    isHero: boolean("is_hero").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pd_key_unique").on(t.key),
    index("pd_active_sort").on(t.isActive, t.sortOrder),
  ],
)

/**
 * 平台尺寸规范（超管配置）
 *
 * 「图片比例」下拉的数据源之一：平台有具体尺寸规范的场景
 * （如 Amazon A+ 模块尺寸），与模型自带 sizePresets 并集展示。
 */
export const platformSizeSpecs = pgTable(
  "platform_size_spec",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 平台标识（对齐 src/lib/product/dictionaries.ts 的 PLATFORMS key） */
    platformKey: varchar("platform_key", { length: 30 }).notNull(),
    /** 尺寸名称（如「高级A+（Web端）」） */
    label: varchar("label", { length: 100 }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /** 展示用比例文案（如 "1:1"、"长图"） */
    ratioLabel: varchar("ratio_label", { length: 30 }),
    /** 规范说明（平台要求备注） */
    note: text("note"),
    /** 适用子功能（A+详情页必配；套图可选） */
    appliesTo: jsonb("applies_to")
      .$type<ProductSizeSpecScope[]>()
      .default(["detail"])
      .notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("pss_platform").on(t.platformKey, t.sortOrder),
    uniqueIndex("pss_platform_label_unique").on(t.platformKey, t.label),
  ],
)

/**
 * 上架平台（超管配置；表空/所选 key 缺行时回退 dictionaries.ts 的 PLATFORMS 常量）
 *
 * 平台的差异化「要求规则」即两段提示词：主图规范（注入首屏主视觉类方向）
 * 与通用平台偏好（注入所有方向）。
 */
export const productPlatforms = pgTable(
  "product_platform",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 30 }).notNull(),
    label: varchar("label", { length: 100 }).notNull(),
    /** 注入首屏主视觉类方向（hero_visual）的平台主图规范 */
    heroPromptSegment: text("hero_prompt_segment"),
    /** 注入所有方向的通用平台偏好 */
    generalPromptSegment: text("general_prompt_segment"),
    sortOrder: integer("sort_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pp_key_unique").on(t.key),
    index("pp_active_sort").on(t.isActive, t.sortOrder),
  ],
)

/** 语言（超管配置；回退 dictionaries.ts 的 LANGUAGES 常量） */
export const productLanguages = pgTable(
  "product_language",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 20 }).notNull(),
    label: varchar("label", { length: 100 }).notNull(),
    /** AI 帮写/智能匹配输出语言名（喂给对话模型） */
    outputName: varchar("output_name", { length: 100 }).notNull(),
    /** 生图图内文字语言指令 */
    imageDirective: text("image_directive"),
    sortOrder: integer("sort_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("plg_key_unique").on(t.key),
    index("plg_active_sort").on(t.isActive, t.sortOrder),
  ],
)

/** 提示词模板场景标识（商品主图各环节的预组装提示词） */
export const PRODUCT_PROMPT_SCENES = [
  "suite.ai_write", // 商品套图 AI 帮写
  "detail.ai_write", // A+详情页 AI 帮写
  "suite.smart_match", // 商品套图智能匹配规划
  "suite.card_prompt", // 商品套图卡片画面提示词生成（批量/单卡共用）
  "replicate.level_style", // 爆款复刻「参考风格」
  "replicate.level_strict", // 爆款复刻「高度复刻」
  "weartry.outfit_ai_write", // 穿戴-服装组图 AI 帮写
  "weartry.model_image", // 穿戴-生成模特形象
  "weartry.tryon", // 穿戴-模特穿戴生图
  "weartry.tryon_accessory", // 穿戴-AI万戴生图
  "weartry.color", // 穿戴-AI换色生图
  "mockup.ai_background", // 样机-AI背景生成
] as const
export type ProductPromptScene = (typeof PRODUCT_PROMPT_SCENES)[number]

/**
 * 提示词模板（超管配置；缺行回退代码内置文案）
 *
 * 模板支持 {{platformLabel}}/{{outputLanguage}}/{{directionPool}} 等变量，
 * 运行时由 fillVars 填充。
 */
export const productPromptTemplates = pgTable(
  "product_prompt_template",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 场景标识（PRODUCT_PROMPT_SCENES，不可改） */
    scene: varchar("scene", { length: 60 }).notNull(),
    /** 管理端展示名（如「套图 AI 帮写」） */
    name: varchar("name", { length: 100 }).notNull(),
    /** 提示词模板正文 */
    template: text("template").notNull(),
    /** 变量与用途说明（管理端帮助文案） */
    note: text("note"),
    sortOrder: integer("sort_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("ppt_scene_unique").on(t.scene)],
)
