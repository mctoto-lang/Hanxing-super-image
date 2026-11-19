import { sql } from "drizzle-orm"
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
import { apiFormatEnum } from "./_shared"
import { enterprises } from "./enterprise"

/**
 * AI 模型（手册 §4.3）
 *
 * - enterpriseId NULL = 平台级共享模型（所有企业可见）；
 *   非 NULL = 企业私有模型。
 * - apiFormat 六格式（2026-11 规范化，见 _shared.ts）：openai = Images 协议
 *   （OpenAI 标准，generations/edits 按参考图分流）；chat = Chat 协议
 *   （OpenAI 兼容对话接口生图）；gemini = Gemini 官方原生（比例生图）；
 *   midjourney = MJ Proxy；jimeng = 即梦反代；grsai = Grsai 统一端点。
 * - 可见性合并：旧项目 visible_in_generate + visible_in_canvas → 单一 visibleInCreate（D13）。
 */
export interface ModelExtraConfig {
  // Jimeng 族
  jimengResolution?: "1k" | "2k" | "4k"
  jimengN?: number
  // Images 协议（openai）：质量参数透传（管理员填入具体值；空 = 不传该字段）
  quality?: string
  // Images 协议（openai）：尺寸传参模式（pixels=size 像素串（默认）/ ratio=
  // 比例参数（nano banana 系中转）/ tier=清晰度档位 1K/2K/4K）。旧 gemini 行的
  // useRatioParam=true 已随 0102 迁移补写 sizeMode='ratio'（读取侧仍保留回退）
  sizeMode?: "pixels" | "ratio" | "tier"
  // Images 协议（openai）：tier 模式固定档位（空/缺省 = 按预设像素自动推导；
  // 固定后前端自定义尺寸置灰、size 恒传该档位）
  tierValue?: "1K" | "2K" | "4K"
  // Images 协议（openai）：response_format 透传（url / b64_json；缺省不传）
  responseFormat?: "url" | "b64_json"
  // Grsai 格式：清晰度档位手动覆盖（空 = 按预设尺寸自动推导）。
  // 旧键 grsai_image_size 为存量数据（历史行仍存旧键），读取侧双读兼容、新键优先
  grsaiImageSize?: "1K" | "2K" | "4K"
  // Midjourney：追加到 prompt 末尾的参数后缀（如 "--v 8.2 --fast"，管理员配置；
  // --ar 由所选比例自动生成，追加在参数后缀之前）
  mjFlags?: string
  [key: string]: unknown
}

/**
 * 模型尺寸预设（结构化，替代旧 supportedSizes 字符串数组）
 *
 * 每条 = 一个可选比例：ratio 为比例文案（如 "1:1"，缺省由 width/height gcd
 * 归约推导），width/height 为对应的实际像素尺寸（比例协议模型经适配器换算为
 * 比例参数，像素仅用于图标比例与展示）。label 为旧展示文案字段（新数据以
 * ratio 为准，读取侧 label 缺省回退 ratio）。
 *
 * icon：前端比例选择器的图标样式预置项（outline=描边比例框（默认，按宽高比
 * 缩放）/ solid=实底比例块 / shape=方向形状图标），不可上传自定义图。
 *
 * enabled：后台可逐个开启/关闭某个比例。false 时创作页置灰不可选，
 * 且不会进入提交尺寸白名单。缺省视为 true（兼容旧数据）。
 */
export interface ModelSizePreset {
  label?: string
  ratio?: string
  width: number
  height: number
  icon?: "outline" | "solid" | "shape"
  enabled?: boolean
}

export const models = pgTable(
  "model",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id").references(() => enterprises.id, {
      onDelete: "cascade",
    }), // NULL = 平台生图模型
    name: varchar("name", { length: 100 }).notNull(),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    /** 模型描述：展示在自由创作模型卡片名称下方，可空 */
    description: text("description"),
    /** 名称后勋章文字（如 "NEW"），可空 */
    badgeText: varchar("badge_text", { length: 30 }),
    /** 勋章配色 key（见 src/lib/model-badges.ts 色板），可空 */
    badgeColor: varchar("badge_color", { length: 30 }),
    /** 展示排序（超管拖拽维护；小在前，回退 createdAt） */
    sortOrder: integer("sort_order").default(0).notNull(),
    apiEndpoint: text("api_endpoint").notNull(),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    apiFormat: apiFormatEnum("api_format").default("openai").notNull(),
    extraConfig: jsonb("extra_config").$type<ModelExtraConfig>(),
    costPerImage: integer("cost_per_image").default(1).notNull(),
    /** 结构化尺寸预设（替代 supportedSizes） */
    sizePresets: jsonb("size_presets").$type<ModelSizePreset[]>(),
    /** 创作页是否显示 1-4 生成数量选择（即梦模型下为「次数」，每次出 jimengN 张） */
    supportsImageCount: boolean("supports_image_count")
      .default(false)
      .notNull(),
    /** 是否支持「智能」比例（选择后 size 传 auto，由模型决定尺寸） */
    supportsSmartSize: boolean("supports_smart_size")
      .default(false)
      .notNull(),
    /** 旧「Gemini 系中转」格式的比例开关（该类行已随 0102 迁移为 openai/Images 协议，
     *  比例行为由 extraConfig.sizeMode='ratio' 承载；新代码不再写入，读取侧保留回退兼容） */
    useRatioParam: boolean("use_ratio_param").default(false).notNull(),
    /** 比例/档位参数字段名（Images 协议 ratio/tier 模式用；空 = ratio→aspect_ratio、tier→size） */
    ratioParamField: varchar("ratio_param_field", { length: 50 }),
    visibleInCreate: boolean("visible_in_create").default(true).notNull(),
    visibleInWorkspace: boolean("visible_in_workspace")
      .default(false)
      .notNull(),
    visibleInProduct: boolean("visible_in_product").default(false).notNull(),
    visibleInWeartry: boolean("visible_in_weartry")
      .default(false)
      .notNull(),
    /** 样机渲染页 AI 生图（背景/重绘）可选 */
    visibleInMockup: boolean("visible_in_mockup").default(false).notNull(),
    supportsReferenceImage: boolean("supports_reference_image")
      .default(false)
      .notNull(),
    maxReferenceImages: integer("max_reference_images").default(0).notNull(),
    // 无列级默认：各接口格式默认不同（openai→image、即梦→filePaths），
    // NULL 时由读取端按格式取默认（见 image-model-config.ts）
    referenceImageField: varchar("reference_image_field", {
      length: 50,
    }),
    maxConcurrent: integer("max_concurrent").default(2).notNull(),
    maxRetries: integer("max_retries").default(2).notNull(),
    apiTimeout: integer("api_timeout").default(120).notNull(),
    taskTimeout: integer("task_timeout").default(300).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    iconUrl: text("icon_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // 按企业列模型
    index("model_ent").on(t.enterpriseId),
    index("model_active_create").on(t.isActive, t.visibleInCreate),
    // 用户侧各模型列表统一 order by (sortOrder, createdAt)
    index("model_sort").on(t.sortOrder, t.createdAt),
    // 唯一约束：含可空 enterprise_id 时 Postgres NULL≠NULL 会导致平台级（NULL）模型
    // 唯一性失效，故拆为两个 partial unique index 分别覆盖：
    // 企业私有模型——同企业内 (name, api_endpoint) 唯一
    uniqueIndex("model_name_endpoint_ent_unique")
      .on(t.name, t.apiEndpoint, t.enterpriseId)
      .where(sql`${t.enterpriseId} IS NOT NULL`),
    // 平台级模型（enterprise_id IS NULL）——(name, api_endpoint) 全局唯一
    uniqueIndex("model_name_endpoint_platform_unique")
      .on(t.name, t.apiEndpoint)
      .where(sql`${t.enterpriseId} IS NULL`),
  ],
)
