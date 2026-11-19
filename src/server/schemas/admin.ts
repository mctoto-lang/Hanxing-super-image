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

/** 禁用/启用成员（禁用后无法登录，业务操作即时降权） */
export const setMemberStatusSchema = z.object({
  userId: z.string().uuid(),
  status: z.enum(["active", "disabled"]),
})

/** 管理员重置成员密码（本人走个人设置，不可用此入口） */
export const resetMemberPasswordSchema = z.object({
  userId: z.string().uuid(),
  newPassword: z.string().min(6, "密码至少 6 字符").max(128),
})

/** 管理员编辑成员昵称/邮箱（用户名不可改） */
export const updateMemberProfileSchema = z.object({
  userId: z.string().uuid(),
  name: z.string().max(100).optional(),
  email: z.string().email("邮箱格式错误").optional().or(z.literal("")),
})

/** 权限组成员整组转移（删除组前须先清空成员） */
export const moveGroupMembersSchema = z
  .object({
    fromGroupId: z.string().uuid(),
    toGroupId: z.string().uuid(),
  })
  .refine((d) => d.fromGroupId !== d.toGroupId, {
    message: "目标组不能与当前组相同",
  })

export const permissionGroupSchema = z.object({
  name: z.string().min(2, "组名至少 2 字符").max(100),
  description: z.string().max(500).optional(),
  allowedModels: z.array(z.string().uuid()).default([]),
  allowedChatModels: z.array(z.string().uuid()).default([]),
  allowedPages: z.array(z.enum(MODULE_NAMES)).default([]),
  maxConcurrent: z.number().int().min(1).max(9999).default(2),
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
  /** 接口格式（六格式）：openai=Images 协议 / chat=Chat 协议 / gemini=Gemini
   *  官方原生 / midjourney=MJ Proxy / jimeng=即梦反代 / grsai=Grsai 统一端点 */
  apiFormat: z.enum(["openai", "chat", "gemini", "midjourney", "jimeng", "grsai"]),
  jimengResolution: z.enum(["1k", "2k", "4k"]).optional(),
  jimengN: z.number().int().min(1).max(8).optional(),
  /** Images 协议（openai）质量参数透传（管理员填入具体值；空 = 不传） */
  quality: z.string().trim().max(50).optional(),
  /**
   * 尺寸传参模式（Images 协议 openai 专属，落 extraConfig.sizeMode）：
   * pixels = size 像素串（默认）/ ratio = 比例参数（nano banana 系中转）/
   * tier = 清晰度档位（1K/2K/4K，按预设像素推导或 tierValue 固定）
   */
  sizeMode: z.enum(["pixels", "ratio", "tier"]).optional(),
  /** tier 模式固定档位（空 = 按预设像素自动推导） */
  tierValue: z.enum(["1K", "2K", "4K"]).optional(),
  /** response_format 透传（Images 协议；空 = 不传） */
  responseFormat: z.enum(["url", "b64_json"]).optional(),
  /** grsai 格式：清晰度档位手动覆盖（空 = 按预设尺寸自动推导） */
  grsaiImageSize: z.enum(["1K", "2K", "4K"]).optional(),
  /** midjourney 格式：prompt 参数后缀（--ar 自动生成并剔重；空 = 不追加） */
  mjFlags: z.string().trim().max(200).optional(),
  /** 旧 gemini 比例传参开关（存量兼容；新配置走 sizeMode，读取侧 sizeMode 优先） */
  useRatioParam: z.boolean().default(false),
  /**
   * 比例/档位参数字段名（Images 协议的 ratio/tier 模式生效；
   * 空 = ratio→aspect_ratio、tier→size）
   */
  ratioParamField: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "比例字段名仅限字母、数字与下划线，且不能以数字开头")
    .max(50)
    .optional(),
  costPerImage: z.number().int().min(0).default(1),
  description: z.string().max(300).optional(),
  badgeText: z.string().max(30).optional(),
  badgeColor: z.string().max(30).optional(),
  sizePresets: z
    .array(
      z.object({
        /** 旧展示文案字段（兼容存量；新数据以 ratio 为准，可缺省） */
        label: z.string().trim().max(20).optional(),
        /** 展示比例（如 "16:9"；缺省由 width/height 归约推导） */
        ratio: z
          .string()
          .trim()
          .regex(/^\d+:\d+$/, "比例格式为 W:H（如 16:9）")
          .max(20)
          .optional(),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
        /** 前端比例图标样式（outline 描边比例框（默认）/ solid 实底比例块 / shape 方向形状图标） */
        icon: z.enum(["outline", "solid", "shape"]).optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .max(24)
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
  maxConcurrent: z.number().int().min(1).max(9999).default(2),
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
  /** 百万输入 token 价格（厘 = 0.01 积分；0 = 免费；上限 10000 积分） */
  inputPriceCenticredits: z
    .number()
    .int()
    .min(0)
    .max(1_000_000, "每百万 tokens 输入价格不能超过 10000 积分")
    .default(0),
  /** 百万输出 token 价格（厘 = 0.01 积分；0 = 免费；上限 10000 积分） */
  outputPriceCenticredits: z
    .number()
    .int()
    .min(0)
    .max(1_000_000, "每百万 tokens 输出价格不能超过 10000 积分")
    .default(0),
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
  maxConcurrent: z.number().int().min(1).max(9999).default(5),
  maxRetries: z.number().int().min(0).default(3),
  apiTimeout: z.number().int().min(1).default(120),
  taskTimeout: z.number().int().min(0).default(300),
  iconUrl: z.string().max(500).optional(),
})
