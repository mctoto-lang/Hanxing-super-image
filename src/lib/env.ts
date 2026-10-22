import { z } from "zod"

/**
 * 环境变量校验（手册 §8.1、§10.7）
 *
 * 启动时强制校验：AUTH_SECRET / ENCRYPTION_KEY 不得为空、不得为默认值。
 * 任一校验失败 → 服务拒绝启动（计费/加密系统的红线）。
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  NEXT_PUBLIC_APP_NAME: z.string().default("瀚星 Super Image"),
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url()
    .default("http://localhost:3000"),

  // 数据库
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL 不能为空")
    .startsWith("postgresql://", "DATABASE_URL 必须是 postgresql:// 连接串"),
  // 单进程 PG 连接池上限（worker 高并发场景在 compose 中按副本调大）
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

  // Redis
  REDIS_URL: z
    .string()
    .min(1, "REDIS_URL 不能为空")
    .default("redis://localhost:6379"),

  // 认证
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET 至少 32 字符，生产环境必改"),
  AUTH_TRUST_HOST: z
    .union([z.literal("true"), z.literal("false")])
    .default("true"),

  // 加密
  ENCRYPTION_KEY: z
    .string()
    .min(32, "ENCRYPTION_KEY 至少 32 字符")
    .refine(
      (v) => v !== "change_me_32_chars_min_aaaaaaaa",
      "ENCRYPTION_KEY 不得使用示例默认值",
    ),

  // 初始超管
  SUPERADMIN_USERNAME: z.string().min(2).default("superadmin"),
  SUPERADMIN_PASSWORD: z.string().optional(),

  // 腾讯云 COS（可选）
  COS_SECRET_ID: z.string().optional(),
  COS_SECRET_KEY: z.string().optional(),
  COS_BUCKET: z.string().optional(),
  COS_REGION: z.string().optional(),
  COS_BASE_URL: z.string().optional(),
  COS_IMAGE_PREFIX: z.string().default("image/"),

  // 样机渲染外部服务（可选；仅开发兜底，生产以超管按企业配置为准）
  MOCKUP_API_BASE_URL: z.string().optional(),
  MOCKUP_API_KEY: z.string().optional(),
  MOCKUP_COST_PER_RENDER: z.coerce.number().int().min(1).optional(),

  // 队列
  CRON_SECRET: z.string().min(1, "CRON_SECRET 不能为空"),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().default(2000),
  // 单 worker 进程内并行处理的任务数上限（企业/模型 Redis 槽位仍是跨进程总闸门）
  WORKER_TASK_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
  // 转存下载并发上限：防止高并发波次打满服务器入方向带宽导致 30s 下载超时雪崩。
  // 经验值 ≈ 入方向带宽 Mbps × 2 ÷ 平均图片 MB（12M 带宽、2MB 图 ≈ 16）
  TRANSFER_CONCURRENCY: z.coerce.number().int().min(4).max(128).default(16),

  // /uploads 无签名访问宽限期截止（ISO 日期，如 2026-10-08）。到期后本地
  // 存储图片强制「登录会话或 HMAC 令牌」；未配置视为宽限中。上线后将此值
  // 设为部署日 + 30 天，到期观察日志无无签名流量后保持强制。
  UPLOADS_UNSIGNED_GRACE_END: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  // 服务端进程才允许读取（避免客户端 bundle）
  if (typeof window !== "undefined") {
    throw new Error("env.ts 只能在服务端读取")
  }

  const parsed = envSchema.safeParse(process.env)

  if (!parsed.success) {
    console.error("❌ 环境变量校验失败：")
    for (const issue of parsed.error.issues) {
      console.error(`   - ${issue.path.join(".")}: ${issue.message}`)
    }
    // next build 的页面数据收集会模块级求值本文件，而镜像构建期没有密钥
    // （.dockerignore 排除 .env*）是常态：构建期放行（NEXT_PHASE 由 Next.js
    // 注入），真实校验留给运行时（standalone server / worker / migrate 均
    // 会重新求值且无 NEXT_PHASE，缺失即拒绝启动）。
    const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build"
    if (process.env.NODE_ENV === "production" && !isBuildPhase) {
      throw new Error("环境变量校验失败，拒绝启动")
    }
    console.warn(
      "⚠️ 开发环境将以未校验的 process.env 继续运行：缺失字段为 undefined，" +
        "依赖它们的功能（如 CRON_SECRET 定时任务鉴权）会显式失败，请补齐 .env",
    )
  }

  // 开发期允许部分缺失（用宽松默认值继续），但仍返回解析结果
  return parsed.success ? parsed.data : (process.env as unknown as Env)
}

/**
 * 校验后的环境变量（服务端专用）。
 *
 * 注意：只在被服务端模块按需 import 时才会触发校验，
 * 因此缺失关键变量的客户端构建不会受影响。
 */
export const env = loadEnv()
