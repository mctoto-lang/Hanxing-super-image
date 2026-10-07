import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core"
import { enterprises } from "./enterprise"
import { users } from "./auth"
import type {
  AgentAssetKind,
  AgentDirection,
  AgentMessageMeta,
  AgentPendingAction,
  AgentTemplateDirection,
  AgentFrameMode,
  AgentFrameStatus,
  AgentGraph,
  AgentItemStatus,
  AgentMessageRole,
  AgentNodeType,
  AgentPromptSource,
  AgentRunInput,
  AgentRunPhase,
  AgentRunStatus,
  AgentTemplateStage,
  AgentThinkingLevel,
  ReviewResultPayload,
  RoundCandidate,
  VerdictPayload,
} from "@/lib/agent/graph"
import type { DirectionConfig } from "@/lib/agent/pipelines"

/**
 * AI Agent 域（/agent 卡牌工坊：固定流水线 + 层级看板）
 *
 * 移植 ai-card-studio 的留痕结构（Card/Round/ReviewResult/TeamEvent）并适配
 * 本项目多租户体系：全部业务表带 enterpriseId + userId 双过滤。
 *
 * - 固定流水线：三条产品线（塔罗/神谕/扑克）由代码构造（buildPipelineGraph），
 *   管理员仅经 agent_direction_config 配置各角色模型与阈值，用户零配置；
 * - 运行快照：agent_run.graphSnapshot 存发起时的图结构；
 * - 留痕三件套：round（每轮尝试）/ review（审核+裁决）/ event（时间线），
 *   支撑看板的逐轮回放与 Agent 任务明细。
 */

/**
 * 产品线配置（平台管理员预配置；每方向一行）
 * thresholds/models 为 jsonb 结构化配置（见 lib/agent/pipelines 的 DirectionConfig）。
 */
export const agentDirectionConfigs = pgTable(
  "agent_direction_config",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    direction: varchar("direction", { length: 20 }).$type<AgentDirection>().notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    /** 两阶段模式：先出小样等确认风格，再跑全套 */
    sampleEnabled: boolean("sample_enabled").default(true).notNull(),
    sampleCount: integer("sample_count").default(6).notNull(),
    maxRetries: integer("max_retries").default(2).notNull(),
    thresholds: jsonb("thresholds")
      .$type<{ aestheticThreshold: number; consistencyThreshold: number }>()
      .notNull(),
    models: jsonb("models")
      .$type<
        DirectionConfig["models"] & { copywriterThinkingLevel?: AgentThinkingLevel }
      >()
      .notNull(),
    /** 模板专属配置（当前为 tarot；旧方向可为空） */
    templateConfig: jsonb("template_config").$type<DirectionConfig["templateConfig"]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("adc_direction_unique").on(t.direction)],
)

/** 运行实例（对齐 ai-card-studio 的 Deck；固定流水线，无用户工作流） */
export const agentRuns = pgTable(
  "agent_run",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    direction: varchar("direction", { length: 20 }).$type<AgentDirection>(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).$type<AgentRunStatus>().default("queued").notNull(),
    /** 两阶段：sample = 小样阶段；full = 全套阶段（关闭小样时直接 full） */
    phase: varchar("phase", { length: 10 }).$type<AgentRunPhase>().default("sample").notNull(),
    input: jsonb("input").$type<AgentRunInput>().notNull(),
    /** 运行时图快照：worker 按此执行 */
    graphSnapshot: jsonb("graph_snapshot").$type<AgentGraph>().notNull(),
    /** 风格定稿 Agent 产出的《风格规范书》（下游文案/审核引用） */
    styleDoc: text("style_doc"),
    /** 卡面模板 key（模板化分阶段制作；null = 经典全流程） */
    template: varchar("template", { length: 60 }),
    /** 模板当前阶段（AGENT_TEMPLATE_STAGES；经典全流程为 null。存量行可能带旧值 world/prompt——读取侧经 normalizeTemplateStage 归一化） */
    stage: varchar("stage", { length: 16 }).$type<AgentTemplateStage | "world" | "prompt">(),
    /** 运行标题（列表/看板展示名；空 = 回退 prompt 截断） */
    title: varchar("title", { length: 120 }),
    /** 创作简报（模板化流程的结构化需求描述，下游各 Agent 引用） */
    brief: text("brief"),
    /** 模板流程待执行动作（queued 时由 worker 认领执行；null = 无待执行动作） */
    pendingAction: jsonb("pending_action").$type<AgentPendingAction | null>(),
    /** 参与方向集合（空 = 单方向，按 direction 列执行） */
    directions: jsonb("directions").$type<AgentTemplateDirection[]>().default([]).notNull(),
    /** 多方向流程中用户最终选定的方向 */
    selectedDirection: varchar("selected_direction", { length: 20 }).$type<AgentDirection>(),
    /** 模板流程中用户选定的方向 id（directions[].id；重新生成方向时清空） */
    selectedDirectionId: varchar("selected_direction_id", { length: 40 }),
    /** 卡框模式（AGENT_FRAME_MODES）：custom 时引用 frameAssetId */
    frameMode: varchar("frame_mode", { length: 12 }).$type<AgentFrameMode>().default("ai").notNull(),
    /** 卡框素材 id（agent_asset.id；无 FK，避免与 agent_asset 循环引用，同 finalRoundId 先例） */
    frameAssetId: uuid("frame_asset_id"),
    /** LLM 累计成本（厘 = 0.01 积分，与 chat_message.costCenticredits 同单位） */
    costCenticredits: integer("cost_centicredits").default(0).notNull(),
    /** 未结算厘零头（满 100 厘 = 1 积分才原子扣企业池，与 chat 结算同策略） */
    unbilledCenticredits: integer("unbilled_centicredits").default(0).notNull(),
    /** 生图累计扣费（积分，按张） */
    imageCostCredits: integer("image_cost_credits").default(0).notNull(),
    /** 实际成功生图张数 */
    imageCount: integer("image_count").default(0).notNull(),
    /** LLM 调用次数 */
    llmCallCount: integer("llm_call_count").default(0).notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("ar_ent_user_created").on(t.enterpriseId, t.userId, t.createdAt),
    // worker 扫描入口：待处理运行
    index("ar_status_created").on(t.status, t.createdAt),
  ],
)

/** 单卡流水线（对齐 ai-card-studio 的 Card；一次运行的每张卡独立执行） */
export const agentRunItems = pgTable(
  "agent_run_item",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 卡序号（0 起，与结构清单顺序一致） */
    index: integer("index").notNull(),
    name: varchar("name", { length: 200 }),
    meaning: text("meaning"),
    /** 当前提示词（每轮改写后更新；完整历史在 agent_round.prompt） */
    currentPrompt: text("current_prompt"),
    promptSource: varchar("prompt_source", { length: 12 }).$type<AgentPromptSource>(),
    status: varchar("status", { length: 16 }).$type<AgentItemStatus>().default("pending").notNull(),
    /** 风格小样卡（两阶段模式先只跑这些） */
    isSample: boolean("is_sample").default(false).notNull(),
    /** 已用打回轮数（裁决 retry 时 +1，与打回上限比较） */
    roundsUsed: integer("rounds_used").default(0).notNull(),
    /** 终版轮次（兜底选中/人工确认；无 FK，避免与 agent_round 循环引用） */
    finalRoundId: uuid("final_round_id"),
    /** 兜底选中但质检未通过（前端红警示） */
    fallbackContentWarning: boolean("fallback_content_warning").default(false).notNull(),
    /** 手动重开计数（成本失控软限流提醒） */
    manualRegenCount: integer("manual_regen_count").default(0).notNull(),
    errorMessage: text("error_message"),
    /** 视觉简报（文案 Agent 产出的逐卡画面描述；模板化流程新增） */
    visualBrief: text("visual_brief"),
    /** 套框成图 URL（卡框合成产物；无框底图在 agent_round.image_url） */
    framedImageUrl: text("framed_image_url"),
    /** AI 融合状态（AGENT_FRAME_STATUSES；历史运行可为空） */
    frameStatus: varchar("frame_status", { length: 12 }).$type<AgentFrameStatus>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // 并发创建清单的兜底唯一约束（先查后插竞态下防 78 张插成两份）
    uniqueIndex("ari_run_index_unique").on(t.runId, t.index),
    index("ari_ent_user_status").on(t.enterpriseId, t.userId, t.status),
  ],
)

/** 每轮生成尝试（对齐 ai-card-studio 的 Round） */
export const agentRounds = pgTable(
  "agent_round",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => agentRunItems.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull(),
    /** 本轮实际使用的完整 prompt（可回放） */
    prompt: text("prompt").notNull(),
    promptSource: varchar("prompt_source", { length: 12 }).$type<AgentPromptSource>().default("initial").notNull(),
    /** 本轮选中进入下游的最优候选 URL（null = 生图失败） */
    imageUrl: text("image_url"),
    generationMeta: jsonb("generation_meta"),
    /** 全部候选及评分（candidateCount > 1 时多候选留档） */
    candidates: jsonb("candidates").$type<RoundCandidate[]>().default([]).notNull(),
    /** 本轮生图扣费（积分） */
    costCredits: integer("cost_credits").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("ard_item_round").on(t.itemId, t.roundNumber),
    index("ard_run_idx").on(t.runId),
  ],
)

/** 审核与裁决记录（对齐 ai-card-studio 的 ReviewResult） */
export const agentReviews = pgTable(
  "agent_review",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => agentRunItems.id, { onDelete: "cascade" }),
    roundId: uuid("round_id")
      .notNull()
      .references(() => agentRounds.id, { onDelete: "cascade" }),
    /** 产生该记录的图节点 id */
    nodeKey: varchar("node_key", { length: 60 }).notNull(),
    /** review = 审核维度结论；verdict = 总控裁决 */
    kind: varchar("kind", { length: 10 }).notNull(),
    result: jsonb("result").$type<ReviewResultPayload | VerdictPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("arev_round_idx").on(t.roundId),
    index("arev_run_created").on(t.runId, t.createdAt),
  ],
)

/** 事件时间线（对齐 ai-card-studio 的 TeamEvent；看板实时日志） */
export const agentEvents = pgTable(
  "agent_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /** 产生事件的图节点 id（run 级事件为空） */
    nodeKey: varchar("node_key", { length: 60 }),
    nodeType: varchar("node_type", { length: 20 }).$type<AgentNodeType>(),
    /** start | done | fail | retry | fallback | confirm | regen | pause | resume | cancel */
    action: varchar("action", { length: 12 }).notNull(),
    /** ok | warn | error（前端时间线配色） */
    status: varchar("status", { length: 8 }).notNull(),
    detail: text("detail"),
    itemId: uuid("item_id"),
    roundId: uuid("round_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("aev_run_created").on(t.runId, t.createdAt)],
)

/** 素材留痕（模板化流程：参考图 / 卡框 / 生成图 / 导出物） */
export const agentAssets = pgTable(
  "agent_asset",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 所属运行（null = 平台级素材，如内置卡框） */
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "cascade" }),
    /** 素材类型（AGENT_ASSET_KINDS） */
    kind: varchar("kind", { length: 16 }).$type<AgentAssetKind>().notNull(),
    /** 素材名（列表展示） */
    name: varchar("name", { length: 200 }),
    url: text("url").notNull(),
    /** 结构化元信息（尺寸/用途备注等，按 kind 自定义） */
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("aas_run_created").on(t.runId, t.createdAt)],
)

/** 对话消息留痕（工坊内与 Agent 的逐条消息；回放与审计用） */
export const agentMessages = pgTable(
  "agent_message",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    /** 消息角色（AGENT_MESSAGE_ROLES） */
    role: varchar("role", { length: 12 }).$type<AgentMessageRole>().notNull(),
    content: text("content").notNull(),
    /** 产生消息的图节点 id（run 级消息为空） */
    nodeKey: varchar("node_key", { length: 60 }),
    /** 结构化元信息（澄清轮次/简报/方向清单等，按消息类型自定义；见 AgentMessageMeta） */
    meta: jsonb("meta").$type<AgentMessageMeta | null>(),
    /** 关联卡牌（item 级消息；无 FK，同 agent_event.itemId 先例） */
    itemId: uuid("item_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("amsg_run_created").on(t.runId, t.createdAt)],
)

export type AgentDirectionConfigRow = typeof agentDirectionConfigs.$inferSelect
export type AgentRunRow = typeof agentRuns.$inferSelect
export type AgentRunItemRow = typeof agentRunItems.$inferSelect
export type AgentRoundRow = typeof agentRounds.$inferSelect
export type AgentReviewRow = typeof agentReviews.$inferSelect
export type AgentEventRow = typeof agentEvents.$inferSelect
export type AgentAssetRow = typeof agentAssets.$inferSelect
export type AgentMessageRow = typeof agentMessages.$inferSelect
