import { z } from "zod"
import { MODULE_NAMES } from "@/db/schema"

/**
 * 企业管理员 zod schemas（手册 M2）
 */

export const createMemberSchema = z.object({
  username: z
    .string()
    .min(2, "用户名至少 2 字符")
    .max(50)
    .regex(/^[a-zA-Z0-9_-]+$/, "用户名只能含字母、数字、下划线、短横线"),
  password: z.string().min(6, "密码至少 6 字符").max(128),
  name: z.string().max(100).optional(),
  email: z.string().email("邮箱格式错误").optional().or(z.literal("")),
  role: z.enum(["owner", "admin", "member"]).optional(),
  groupId: z.string().uuid().optional(),
})

export const changeRoleSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["owner", "admin", "member"]),
})

export const assignGroupSchema = z.object({
  userId: z.string().uuid(),
  groupId: z.string().uuid(),
})

export const permissionGroupSchema = z.object({
  name: z.string().min(2, "组名至少 2 字符").max(100),
  description: z.string().max(500).optional(),
  allowedModels: z.array(z.string().uuid()).default([]),
  allowedChatModels: z.array(z.string().uuid()).default([]),
  allowedPages: z.array(z.enum(MODULE_NAMES)).default([]),
  maxConcurrent: z.number().int().min(1).max(100).default(2),
  priority: z.number().int().min(0).max(100).default(0),
})

/**
 * 模型配置 zod schema（手册 §4.3、M3）
 *
 * extraConfig 字段按 apiFormat 扁平收集，由 action 组装为对象并经
 * validateImageModelConfig 白名单校验。
 */
export const modelConfigSchema = z.object({
  name: z.string().min(1, "请输入模型标识").max(100),
  displayName: z.string().min(1, "请输入显示名").max(200),
  apiEndpoint: z.string().min(1, "请输入 API 地址").max(500),
  apiKey: z.string().optional(), // 创建时必填（action 内校验），编辑留空=不修改
  apiFormat: z.enum(["openai", "jimeng"]),
  jimengResolution: z.enum(["1k", "2k", "4k"]).optional(),
  jimengN: z.number().int().min(1).max(8).optional(),
  costPerImage: z.number().int().min(0).default(1),
  description: z.string().max(300).optional(),
  badgeText: z.string().max(30).optional(),
  badgeColor: z.string().max(30).optional(),
  sizePresets: z
    .array(
      z.object({
        label: z.string().trim().min(1, "比例名称不能为空").max(20),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
        enabled: z.boolean().optional(),
      }),
    )
    .default([]),
  supportsImageCount: z.boolean().default(false),
  supportsSmartSize: z.boolean().default(false),
  visibleInCreate: z.boolean().default(true),
  visibleInWorkspace: z.boolean().default(false),
  visibleInProduct: z.boolean().default(false),
  visibleInWeartry: z.boolean().default(false),
  visibleInMockup: z.boolean().default(false),
  supportsReferenceImage: z.boolean().default(false),
  maxReferenceImages: z.number().int().min(0).max(10).default(0),
  referenceImageField: z.string().max(50).optional(),
  maxConcurrent: z.number().int().min(1).default(2),
  maxRetries: z.number().int().min(0).default(2),
  apiTimeout: z.number().int().min(1).default(120),
  taskTimeout: z.number().int().min(0).default(300),
  iconUrl: z.string().max(500).optional(),
})

/**
 * 对话模型配置 zod schema（openai / claude / gemini / grok 四种格式）
 *
 * 除图片特有字段（尺寸预设/参考图/页面可见性等）外与 modelConfigSchema 一致；
 * temperature / maxTokens 落入 extraConfig（工作台内部 AI 用），缺省由 callChatApi 兜底；
 * maxContextTokens / maxOutputTokens / 厘级价格 / 思考强度为 /chat 交互对话专用。
 */
export const chatModelConfigSchema = z.object({
  name: z.string().min(1, "请输入模型标识").max(100),
  displayName: z.string().min(1, "请输入显示名").max(200),
  apiEndpoint: z.string().min(1, "请输入 API 地址").max(500),
  apiKey: z.string().optional(), // 创建时必填（action 内校验），编辑留空=不修改
  formatType: z.enum(["openai", "claude", "gemini", "grok"]).default("openai"),
  description: z.string().max(300).optional(),
  badgeText: z.string().max(30).optional(),
  badgeColor: z.string().max(30).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z
    .number()
    .int()
    .min(0, "Max Tokens 不能为负数")
    .max(1_000_000, "Max Tokens 不能超过 1000000")
    .optional(),
  /** 最大上下文 tokens（上下文圆环分母 + 服务端裁剪预算） */
  maxContextTokens: z
    .number()
    .int()
    .min(1024, "最大上下文至少 1024")
    .max(2_000_000, "最大上下文不能超过 2000000")
    .default(32768),
  /** 单次最大输出 tokens（请求 max_tokens 上限；已有上游支持 384K 输出） */
  maxOutputTokens: z
    .number()
    .int()
    .min(256, "单次最大输出至少 256")
    .max(1_000_000, "单次最大输出不能超过 1000000")
    .default(4096),
  /** 百万输入 token 价格（厘 = 0.01 积分；0 = 免费） */
  inputPriceCenticredits: z.number().int().min(0).max(100_000).default(0),
  /** 百万输出 token 价格（厘 = 0.01 积分；0 = 免费） */
  outputPriceCenticredits: z.number().int().min(0).max(100_000).default(0),
  /** 是否支持思考强度档位 */
  supportsThinking: z.boolean().default(false),
  /** 是否支持多模态（图片输入；开启后对话输入框可 @ 上传图片） */
  supportsVision: z.boolean().default(false),
  /**
   * 各思考档位的上游参数覆盖（extraConfig.thinkingOverrides）。
   * openai/grok 格式读 effort（可传 "xhigh" 等网关自定义值），
   * claude/gemini 读 budgetTokens（gemini 允许 -1 = 动态思考）；
   * 留空的档位用内置默认映射（openai 高档位封顶 high）。
   */
  thinkingOverrides: z
    .record(
      z.enum(["low", "medium", "high", "extra", "max", "ultracode"]),
      z.object({
        effort: z.string().trim().min(1).max(20).optional(),
        budgetTokens: z.number().int().min(-1).max(1_000_000).optional(),
      }),
    )
    .optional(),
  maxConcurrent: z.number().int().min(1).default(5),
  maxRetries: z.number().int().min(0).default(3),
  apiTimeout: z.number().int().min(1).default(120),
  taskTimeout: z.number().int().min(0).default(300),
  iconUrl: z.string().max(500).optional(),
})
