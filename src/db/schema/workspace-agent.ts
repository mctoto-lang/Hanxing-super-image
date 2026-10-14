import { sql } from "drizzle-orm"
import {
  boolean,
  check,
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
import { enterprises } from "./enterprise"
import { users } from "./auth"
import { models } from "./models"
import { generationTasks } from "./tasks"
import {
  cardImages,
  chatApiConfigs,
  promptCards,
  workspaceTasks,
} from "./workspace"
import type {
  WorkspaceAgentCandidate,
  WorkspaceAgentCardKind,
  WorkspaceAgentCardStatus,
  WorkspaceAgentDirectionStatus,
  WorkspaceAgentInput,
  WorkspaceAgentJobPayload,
  WorkspaceAgentJobResult,
  WorkspaceAgentJobStatus,
  WorkspaceAgentOracleCopyStatus,
  WorkspaceAgentPreviewKind,
  WorkspaceAgentPreviewStatus,
  WorkspaceAgentPromptSource,
  WorkspaceAgentReviewKind,
  WorkspaceAgentReviewPayload,
  WorkspaceAgentReviewerReviewPayload,
  WorkspaceAgentStatus,
  WorkspaceAgentUsageKind,
  WorkspaceAgentUsageStatus,
  WorkspaceAgentVerdictPayload,
  WorkspaceAgentSampleCard,
} from "@/lib/workspace/agent-types"

/**
 * 工作台 Agent 域（/workspace 内嵌 AI Agent：批量生图工作台的智能化扩展）
 *
 * 留痕结构对齐 /agent 卡牌工坊（workflow → direction → card → round →
 * review + event 时间线）并适配工作台多租户体系：
 * - 全部表带 enterpriseId 租户隔离；用户可见业务表加 userId 双过滤；
 * - 产出物回链工作台既有表：workspace_task（任务归属）/ prompt_card
 *   （定稿提示词）/ card_image（入库图片）/ generation_task（生图留痕）；
 * - 异步任务队列（job）对齐 chat_task 的重试/退避结构；
 * - usage 为计费留痕账本（LLM 厘 / 生图积分），删除业务行不影响账本
 *   （关联列 set null 或无 FK）。
 *
 * varchar 上的 $type 联合类型与同名 check 约束的字面量保持同步
 * （见 @/lib/workspace/agent-types 的 const 数组）。
 */

/** 工作流实例（一次 Agent 会话：输入 → 方向 → 预览 → 逐卡生产 → 交付） */
export const workspaceAgentWorkflows = pgTable(
  "workspace_agent_workflow",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 挂靠的工作台任务（产出物最终落回该任务；独立发起时为空） */
    workspaceTaskId: uuid("workspace_task_id").references(
      () => workspaceTasks.id,
      { onDelete: "cascade" },
    ),
    /** 运行标题（列表展示名；空 = 回退 input.prompt 截断） */
    title: varchar("title", { length: 120 }),
    status: varchar("status", { length: 20 })
      .$type<WorkspaceAgentStatus>()
      .default("queued")
      .notNull(),
    /** 发起输入快照（jsonb 结构见 WorkspaceAgentInput） */
    input: jsonb("input").$type<WorkspaceAgentInput>().notNull(),
    /** 风格规范书（方向定稿后由 Agent 产出，下游文案/审核引用） */
    styleDoc: text("style_doc"),
    /** 用户选定的方向 id（workspace_agent_direction.id；无 FK，避免与
     *  direction.workflowId 循环引用，同 agent_run.selectedDirectionId 先例） */
    selectedDirectionId: uuid("selected_direction_id"),
    /** LLM 累计成本（厘 = 0.01 积分，与 chat_message.costCenticredits 同单位） */
    costCenticredits: integer("cost_centicredits").default(0).notNull(),
    /** 未结算厘零头（满 100 厘 = 1 积分才原子扣企业池，与 chat 结算同策略） */
    unbilledCenticredits: integer("unbilled_centicredits")
      .default(0)
      .notNull(),
    /** 生图累计扣费（积分，按张） */
    imageCostCredits: integer("image_cost_credits").default(0).notNull(),
    /** 实际成功生图张数 */
    imageCount: integer("image_count").default(0).notNull(),
    /** LLM 调用次数 */
    llmCallCount: integer("llm_call_count").default(0).notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("waw_ent_user_created").on(t.enterpriseId, t.userId, t.createdAt),
    // worker 扫描入口：待处理工作流
    index("waw_status_created").on(t.status, t.createdAt),
    index("waw_task").on(t.workspaceTaskId),
    check(
      "workspace_agent_workflow_status_chk",
      sql`${t.status} IN ('queued', 'running', 'waiting_human', 'completed', 'failed', 'cancelled')`,
    ),
  ],
)

/** 候选创作方向（Agent 产出 N 个待选，用户选定一个后定稿 styleDoc） */
export const workspaceAgentDirections = pgTable(
  "workspace_agent_direction",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workspaceAgentWorkflows.id, { onDelete: "cascade" }),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    /** 一句话概念（方向卡片的首句卖点） */
    concept: text("concept"),
    /** 世界观概述（2-4 句） */
    worldview: text("worldview"),
    /** 主辅色描述 */
    palette: text("palette"),
    /** 视觉语言（拼装进每张卡提示词末尾的整段风格锚点） */
    visualLanguage: text("visual_language"),
    /** 风格短语（20-50 字；仅存储留档，无生产消费方） */
    stylePhrase: varchar("style_phrase", { length: 200 }),
    /** 示例卡（3 张）：牌名 + 该方向下的画面场景 */
    sampleCards: jsonb("sample_cards")
      .$type<WorkspaceAgentSampleCard[]>()
      .default([])
      .notNull(),
    /** 方向示例图 URL（方向产出时同步生成的 1 张预览；失败时缺省为空） */
    exampleImageUrl: text("example_image_url"),
    status: varchar("status", { length: 12 })
      .$type<WorkspaceAgentDirectionStatus>()
      .default("candidate")
      .notNull(),
    /** 展示排序（小在前） */
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("wad_workflow_sort").on(t.workflowId, t.sortOrder),
    check(
      "workspace_agent_direction_status_chk",
      sql`${t.status} IN ('candidate', 'selected', 'rejected')`,
    ),
  ],
)

/**
 * 工作流单卡（每张卡独立执行：撰写 → 生图 → 审核 → 定稿）
 *
 * promptCardId：定稿后回写工作台 prompt_card（Agent 产出物落库工作台，
 * 复用既有的翻译/生图/导出链路）。
 */
export const workspaceAgentCards = pgTable(
  "workspace_agent_card",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workspaceAgentWorkflows.id, { onDelete: "cascade" }),
    /** 设计该卡时依据的方向（方向删除不连坐卡片） */
    directionId: uuid("direction_id").references(
      () => workspaceAgentDirections.id,
      { onDelete: "set null" },
    ),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 卡序号（0 起，与结构清单顺序一致） */
    cardIndex: integer("card_index").notNull(),
    /** 卡类 = 交付用途（face = 卡面；back = 牌背；box = 牌盒；border = 卡框。
     *  四类生产管线不同，同一生产批次禁止混类——批次卡类在
     *  workspace_agent_job.cardKind 声明，应用层校验目标卡片 kind 一致） */
    kind: varchar("kind", { length: 16 })
      .$type<WorkspaceAgentCardKind>()
      .default("face")
      .notNull(),
    name: varchar("name", { length: 200 }),
    /** 牌义/含义（结构策划产出） */
    meaning: text("meaning"),
    /** 视觉简报（文案 Agent 产出的逐卡画面描述） */
    visualBrief: text("visual_brief"),
    /** 当前提示词（每轮改写后更新；完整历史在 workspace_agent_round.prompt） */
    currentPrompt: text("current_prompt"),
    promptSource: varchar("prompt_source", { length: 12 }).$type<WorkspaceAgentPromptSource>(),
    status: varchar("status", { length: 16 })
      .$type<WorkspaceAgentCardStatus>()
      .default("pending")
      .notNull(),
    /** 风格小样卡（两阶段模式先只跑这些） */
    isSample: boolean("is_sample").default(false).notNull(),
    /** 已用打回轮数（裁决 retry 时 +1，与打回上限比较） */
    roundsUsed: integer("rounds_used").default(0).notNull(),
    /** 终版轮次（兜底选中/人工确认；无 FK，避免与 workspace_agent_round 循环引用） */
    finalRoundId: uuid("final_round_id"),
    /** 兜底选中但质检未通过（前端红警示） */
    fallbackContentWarning: boolean("fallback_content_warning")
      .default(false)
      .notNull(),
    /** 手动重开计数（成本失控软限流提醒） */
    manualRegenCount: integer("manual_regen_count").default(0).notNull(),
    /** 用户锁定（终版保护：锁定卡跳过批量重生成/改写任务；DB 约束限制
     *  仅允许锁在已有产出物的状态，见 workspace_agent_card_locked_chk） */
    isLocked: boolean("is_locked").default(false).notNull(),
    /** 定稿回写的工作台提示词卡片（Agent 产出物落库工作台；卡片删除不连坐留痕） */
    promptCardId: uuid("prompt_card_id").references(() => promptCards.id, {
      onDelete: "set null",
    }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // 并发创建清单的兜底唯一约束（先查后插竞态下防整套插成两份，同 ari_run_index_unique）
    uniqueIndex("wac_workflow_index_unique").on(t.workflowId, t.cardIndex),
    index("wac_ent_user_status").on(t.enterpriseId, t.userId, t.status),
    check(
      "workspace_agent_card_status_chk",
      sql`${t.status} IN ('pending', 'drafting', 'generating', 'reviewing', 'waiting_human', 'approved_by_ai', 'fallback', 'confirmed', 'failed', 'cancelled')`,
    ),
    check(
      "workspace_agent_card_kind_chk",
      sql`${t.kind} IN ('face', 'back', 'box', 'border')`,
    ),
    // 锁定语义：只能锁已有产出物的卡（AI 通过/兜底/人工确认），
    // 未产出的卡（pending/drafting/generating/reviewing/waiting_human/failed/cancelled）不可锁
    check(
      "workspace_agent_card_locked_chk",
      sql`NOT ${t.isLocked} OR ${t.status} IN ('approved_by_ai', 'fallback', 'confirmed')`,
    ),
  ],
)

/**
 * 预览图（不进入正式卡图的轻量试生图：风格小样 / 方向示例图 / 单卡试生图）
 *
 * imageUrl + generationTaskId 与 card_image 的存留策略不同：预览图可被
 * 用户放弃，不落 card_image 表，仅在工作台 Agent 域内留痕。
 */
export const workspaceAgentPreviews = pgTable(
  "workspace_agent_preview",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workspaceAgentWorkflows.id, { onDelete: "cascade" }),
    directionId: uuid("direction_id").references(
      () => workspaceAgentDirections.id,
      { onDelete: "set null" },
    ),
    /** 单卡试生图关联的卡（风格/方向级预览为空） */
    cardId: uuid("card_id").references(() => workspaceAgentCards.id, {
      onDelete: "set null",
    }),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 12 })
      .$type<WorkspaceAgentPreviewKind>()
      .notNull(),
    status: varchar("status", { length: 12 })
      .$type<WorkspaceAgentPreviewStatus>()
      .default("pending")
      .notNull(),
    imageUrl: text("image_url"),
    generationTaskId: uuid("generation_task_id").references(
      () => generationTasks.id,
      { onDelete: "set null" },
    ),
    /** 实际用于生图的提示词（可能为英文译文） */
    generationPrompt: text("generation_prompt"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("wap_workflow_created").on(t.workflowId, t.createdAt),
    index("wap_card").on(t.cardId),
    check(
      "workspace_agent_preview_kind_chk",
      sql`${t.kind} IN ('style', 'direction', 'card')`,
    ),
    check(
      "workspace_agent_preview_status_chk",
      sql`${t.status} IN ('pending', 'generating', 'completed', 'failed')`,
    ),
  ],
)

/** 每轮生成尝试（对齐 agent_round；选中图回链 card_image 便于工作台复用） */
export const workspaceAgentRounds = pgTable(
  "workspace_agent_round",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workspaceAgentWorkflows.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => workspaceAgentCards.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull(),
    /** 本轮实际使用的完整 prompt（可回放） */
    prompt: text("prompt").notNull(),
    promptSource: varchar("prompt_source", { length: 12 })
      .$type<WorkspaceAgentPromptSource>()
      .default("initial")
      .notNull(),
    /** 本轮选中进入下游的最优候选 URL（null = 生图失败） */
    imageUrl: text("image_url"),
    /** 选中图回写的工作台卡片图片（Agent 产出物落库工作台；图片删除不连坐留痕） */
    selectedCardImageId: uuid("selected_card_image_id").references(
      () => cardImages.id,
      { onDelete: "set null" },
    ),
    generationTaskId: uuid("generation_task_id").references(
      () => generationTasks.id,
      { onDelete: "set null" },
    ),
    /** 全部候选及评分（candidateCount > 1 时多候选留档） */
    candidates: jsonb("candidates")
      .$type<WorkspaceAgentCandidate[]>()
      .default([])
      .notNull(),
    /** 本轮生图扣费（积分） */
    costCredits: integer("cost_credits").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("war_card_round_unique").on(t.cardId, t.roundNumber),
    index("war_workflow").on(t.workflowId),
  ],
)

/** 审核与裁决记录（对齐 agent_review） */
export const workspaceAgentReviews = pgTable(
  "workspace_agent_review",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workspaceAgentWorkflows.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => workspaceAgentCards.id, { onDelete: "cascade" }),
    roundId: uuid("round_id")
      .notNull()
      .references(() => workspaceAgentRounds.id, { onDelete: "cascade" }),
    /** 产生该记录的图节点 id */
    nodeKey: varchar("node_key", { length: 60 }).notNull(),
    /** review = 审核维度结论（review_image 循环按评审员整行落库）；verdict = 总控裁决 */
    kind: varchar("kind", { length: 10 })
      .$type<WorkspaceAgentReviewKind>()
      .notNull(),
    result: jsonb("result")
      .$type<
        | WorkspaceAgentReviewPayload
        | WorkspaceAgentReviewerReviewPayload
        | WorkspaceAgentVerdictPayload
      >()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("warv_round").on(t.roundId),
    index("warv_workflow_created").on(t.workflowId, t.createdAt),
    check(
      "workspace_agent_review_kind_chk",
      sql`${t.kind} IN ('review', 'verdict')`,
    ),
  ],
)

/**
 * 神谕卡文案（oracle 方向的逐卡牌义：标题/关键词/指引/反思问句）
 *
 * 每卡每语言一行（unique cardId+locale），支持中英双语与译文过期重写。
 */
export const workspaceAgentOracleCopies = pgTable(
  "workspace_agent_oracle_copy",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workspaceAgentWorkflows.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => workspaceAgentCards.id, { onDelete: "cascade" }),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    locale: varchar("locale", { length: 5 }).default("zh").notNull(),
    /** 一句话主旨（卡面/列表展示） */
    headline: varchar("headline", { length: 200 }),
    /** 关键词（检索/标签） */
    keyword: varchar("keyword", { length: 100 }),
    /** 指引文案（抽到该卡时给用户的话） */
    message: text("message"),
    /** 反思问句（可选） */
    question: text("question"),
    status: varchar("status", { length: 12 })
      .$type<WorkspaceAgentOracleCopyStatus>()
      .default("draft")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("waoc_card_locale_unique").on(t.cardId, t.locale),
    check("workspace_agent_oracle_copy_locale_chk", sql`${t.locale} IN ('zh', 'en')`),
    check(
      "workspace_agent_oracle_copy_status_chk",
      sql`${t.status} IN ('draft', 'confirmed', 'outdated')`,
    ),
  ],
)

/**
 * 用量账本（逐调用计费留痕：LLM 厘 / 生图积分）
 *
 * 业务行删除不连坐账本：workflowId/userId/cardId/roundId/cardImageId/
 * generationTaskId 均 set null 或无 FK；对账以 enterpriseId + createdAt 为准。
 */
export const workspaceAgentUsage = pgTable(
  "workspace_agent_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 关联工作流：账本不随业务行删除连坐（工作流删除仅置空，留痕保留对账） */
    workflowId: uuid("workflow_id").references(
      () => workspaceAgentWorkflows.id,
      { onDelete: "set null" },
    ),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: varchar("kind", { length: 10 })
      .$type<WorkspaceAgentUsageKind>()
      .notNull(),
    /** 产生用量的图节点 id（workflow 级调用为空） */
    nodeKey: varchar("node_key", { length: 60 }),
    chatApiId: uuid("chat_api_id").references(() => chatApiConfigs.id, {
      onDelete: "set null",
    }),
    imageModelId: uuid("image_model_id").references(() => models.id, {
      onDelete: "set null",
    }),
    cardId: uuid("card_id").references(() => workspaceAgentCards.id, {
      onDelete: "set null",
    }),
    roundId: uuid("round_id").references(() => workspaceAgentRounds.id, {
      onDelete: "set null",
    }),
    cardImageId: uuid("card_image_id").references(() => cardImages.id, {
      onDelete: "set null",
    }),
    generationTaskId: uuid("generation_task_id").references(
      () => generationTasks.id,
      { onDelete: "set null" },
    ),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** 本调用生成图片张数（image 行） */
    imageCount: integer("image_count"),
    /** LLM 成本（厘 = 0.01 积分；kind = llm 行填写） */
    costCenticredits: integer("cost_centicredits"),
    /** 生图扣费（积分，按张；kind = image 行填写） */
    costCredits: integer("cost_credits"),
    status: varchar("status", { length: 12 })
      .$type<WorkspaceAgentUsageStatus>()
      .default("success")
      .notNull(),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("wau_workflow_created").on(t.workflowId, t.createdAt),
    index("wau_ent_created").on(t.enterpriseId, t.createdAt),
    check("workspace_agent_usage_kind_chk", sql`${t.kind} IN ('llm', 'image')`),
    check(
      "workspace_agent_usage_status_chk",
      sql`${t.status} IN ('success', 'failure', 'timeout')`,
    ),
  ],
)

/** 事件时间线（看板实时日志；对齐 agent_event，action/status 为开放词表） */
export const workspaceAgentEvents = pgTable(
  "workspace_agent_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workspaceAgentWorkflows.id, { onDelete: "cascade" }),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    /** 产生事件的图节点 id（workflow 级事件为空） */
    nodeKey: varchar("node_key", { length: 60 }),
    /** start | done | fail | retry | fallback | confirm | regen | cancel 等（开放词表） */
    action: varchar("action", { length: 12 }).notNull(),
    /** ok | warn | error（前端时间线配色） */
    status: varchar("status", { length: 8 }).notNull(),
    detail: text("detail"),
    /** 关联卡牌/轮次（无 FK，同 agent_event.itemId 先例） */
    cardId: uuid("card_id"),
    roundId: uuid("round_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("wae_workflow_created").on(t.workflowId, t.createdAt)],
)

/**
 * 异步任务队列（对齐 chat_task 的重试/指数退避结构）
 *
 * jobType 为开放集合（无 check）：新增任务类型无需迁移，读取侧按
 * WORKSPACE_AGENT_JOB_TYPES 收敛。
 */
export const workspaceAgentJobs = pgTable(
  "workspace_agent_job",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enterpriseId: uuid("enterprise_id")
      .notNull()
      .references(() => enterprises.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workspaceAgentWorkflows.id, { onDelete: "cascade" }),
    /**
     * 本批次生产的卡类（face/back/box/border；非卡类任务如 gen_directions
     * 为空）。禁止混类批次：入队时应用层校验目标卡片 kind 与此一致，
     * worker 按 cardKind 路由尺寸/模板/评审口径（见类型模块注释）。
     */
    cardKind: varchar("card_kind", { length: 16 }).$type<WorkspaceAgentCardKind>(),
    jobType: varchar("job_type", { length: 30 }).notNull(),
    status: varchar("status", { length: 12 })
      .$type<WorkspaceAgentJobStatus>()
      .default("queued")
      .notNull(),
    payload: jsonb("payload").$type<WorkspaceAgentJobPayload>(),
    result: jsonb("result").$type<WorkspaceAgentJobResult>(),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").default(0).notNull(),
    retryErrors: jsonb("retry_errors")
      .$type<string[]>()
      .default([])
      .notNull(),
    /** 下次可重试时间（指数退避）：为空表示立即可处理；非空表示需等到该时刻后才可被消费 */
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("waj_ent_status").on(t.enterpriseId, t.status),
    index("waj_workflow_created").on(t.workflowId, t.createdAt),
    // 跳过未到点重试任务的高频过滤索引（仅 queued 且有待重试时间的行）
    index("waj_next_retry")
      .on(t.nextRetryAt)
      .where(sql`${t.status} = 'queued' AND ${t.nextRetryAt} IS NOT NULL`),
    // 认领扫描入口（status 前导 + createdAt 有序）：覆盖 next_retry_at IS NULL
    // 的主路径与排序，不必逐行回表过滤（同 waw_status_created 先例）；终态行
    // 清理（cleanupTerminalWorkspaceAgentJobs）亦复用本索引做有界范围删除
    index("waj_status_created").on(t.status, t.createdAt),
    // 崩溃恢复扫描（processing + started_at 超时）：仅收录在途行（量级=并发
    // 数，稳态近空），started_at 直达 cutoff 范围，不随终态行累积膨胀
    index("waj_processing_started")
      .on(t.startedAt)
      .where(sql`${t.status} = 'processing'`),
    check(
      "workspace_agent_job_status_chk",
      sql`${t.status} IN ('queued', 'processing', 'completed', 'failed')`,
    ),
    // 卡类批次声明：非空时必须是四类交付用途之一（混类拦截在应用层，
    // 校验目标卡片 kind == cardKind 后才允许入队）
    check(
      "workspace_agent_job_card_kind_chk",
      sql`${t.cardKind} IS NULL OR ${t.cardKind} IN ('face', 'back', 'box', 'border')`,
    ),
  ],
)

export type WorkspaceAgentWorkflowRow = typeof workspaceAgentWorkflows.$inferSelect
export type WorkspaceAgentDirectionRow = typeof workspaceAgentDirections.$inferSelect
export type WorkspaceAgentCardRow = typeof workspaceAgentCards.$inferSelect
export type WorkspaceAgentPreviewRow = typeof workspaceAgentPreviews.$inferSelect
export type WorkspaceAgentRoundRow = typeof workspaceAgentRounds.$inferSelect
export type WorkspaceAgentReviewRow = typeof workspaceAgentReviews.$inferSelect
export type WorkspaceAgentOracleCopyRow = typeof workspaceAgentOracleCopies.$inferSelect
export type WorkspaceAgentUsageRow = typeof workspaceAgentUsage.$inferSelect
export type WorkspaceAgentEventRow = typeof workspaceAgentEvents.$inferSelect
export type WorkspaceAgentJobRow = typeof workspaceAgentJobs.$inferSelect
