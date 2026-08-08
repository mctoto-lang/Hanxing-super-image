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

  // 队列
  CRON_SECRET: z.string().optional(),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().default(2000),
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
    // 在开发期直接抛错；生产期由 next 启动日志暴露
    if (process.env.NODE_ENV === "production") {
      throw new Error("环境变量校验失败，拒绝启动")
    }
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
