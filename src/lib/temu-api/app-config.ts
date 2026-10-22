import { and, desc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { systemSettings, type SystemSettingValue } from "@/db/schema"
import { decrypt, encrypt } from "@/lib/crypto"
import { TEST_ACCOUNTS, type TemuTestAccount } from "./test-accounts"

/**
 * TEMU 官方开放平台应用凭证（企业级，system_setting key=temu_api_app + enterpriseId）
 *
 * 每个企业可对接各自的自研应用（app_key/secret，超管在企业管理里维护）；
 * 每个店铺各自的 access_token 存 temu_store（见 store-manager）。testMode
 * 开关切换到官方文档测试账号，供正式应用审批下来前开发联调。
 *
 * 企业级 enterpriseId 非 NULL 参与 unique(key, enterpriseId) 约束，
 * 可安全 onConflictDoUpdate（同 mockup 配置的既有约定）。
 */

export interface TemuAppConfig {
  appKey: string
  /** AES-256-GCM 密文（enc:v1: 前缀），空串=未配置 */
  appSecretEncrypted: string
  /** 测试模式：调用时使用官方文档测试账号而非正式凭证 */
  testMode: boolean
}

/** 调用侧拿到的明文凭证 */
export interface TemuAppCredential {
  appKey: string
  appSecret: string
  /** 凭证来源（testMode 时为测试账号名，用于日志/展示） */
  source: "enterprise" | "test"
}

const SETTING_KEY = "temu_api_app"

const SECRET_ENC_PREFIX = "enc:v1:"
const SECRET_MASK_PREFIX = "••••••"

export function encryptTemuSecret(plain: string): string {
  if (!plain) return ""
  return SECRET_ENC_PREFIX + encrypt(plain)
}

export function decryptTemuSecret(stored: string): string {
  if (!stored) return ""
  if (!stored.startsWith(SECRET_ENC_PREFIX)) return stored
  try {
    return decrypt(stored.slice(SECRET_ENC_PREFIX.length))
  } catch (err) {
    console.error(
      "[temu-api] app_secret 解密失败（ENCRYPTION_KEY 轮换后未重加密？）：",
      err instanceof Error ? err.message : err,
    )
    return ""
  }
}

/** 超管回显掩码：仅保留明文尾 4 位；保存时原样提交视为「未修改」 */
export function maskTemuSecret(plain: string): string {
  if (!plain) return ""
  return `${SECRET_MASK_PREFIX}${plain.slice(-4)}`
}

const MASK_RE = new RegExp(`^${SECRET_MASK_PREFIX}`)

/** 掩码前缀判定（保存时原样提交=未修改旧密钥） */
export function isMaskedTemuSecret(value: string): boolean {
  return MASK_RE.test(value)
}

/** 读取企业级 TEMU 应用配置（不含鉴权，调用方自行守卫；未配置返回空值结构） */
export async function loadTemuAppConfig(enterpriseId: string): Promise<TemuAppConfig> {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(and(eq(systemSettings.key, SETTING_KEY), eq(systemSettings.enterpriseId, enterpriseId)))
    .orderBy(desc(systemSettings.updatedAt))
    .limit(1)
  const v = (row?.value ?? {}) as Partial<TemuAppConfig> & SystemSettingValue
  return {
    appKey: typeof v.appKey === "string" ? v.appKey : "",
    appSecretEncrypted: typeof v.appSecretEncrypted === "string" ? v.appSecretEncrypted : "",
    testMode: v.testMode === true,
  }
}

/** 保存企业级 TEMU 应用配置（onConflictDoUpdate，企业行唯一约束可命中） */
export async function saveTemuAppConfig(enterpriseId: string, config: TemuAppConfig): Promise<void> {
  const value = {
    appKey: config.appKey,
    appSecretEncrypted: config.appSecretEncrypted,
    testMode: config.testMode,
  } as unknown as SystemSettingValue
  await db
    .insert(systemSettings)
    .values({
      enterpriseId,
      key: SETTING_KEY,
      value,
      description: "TEMU 官方开放平台应用凭证（app_key/secret，企业级）",
    })
    .onConflictDoUpdate({
      target: [systemSettings.key, systemSettings.enterpriseId],
      set: { value, updatedAt: new Date() },
    })
  resetTemuAppCredentialCache(enterpriseId)
}

/**
 * 取调用凭证：testMode → 官方测试账号（全托）；否则该企业的 app_key/secret。
 * 未配置返回 null，由调用方给出「未配置 TEMU 应用凭证」提示。
 * 30s 进程内缓存（按企业，保存时失效），避免每次 API 调用都查库解密。
 */
export async function getTemuAppCredential(enterpriseId: string): Promise<TemuAppCredential | null> {
  const hit = cache.get(enterpriseId)
  const now = Date.now()
  if (hit && now - hit.at < 30_000) return hit.credential
  const config = await loadTemuAppConfig(enterpriseId)
  let credential: TemuAppCredential | null = null
  if (config.testMode) {
    credential = testAccountCredential(TEST_ACCOUNTS.fullManaged)
  } else if (config.appKey && config.appSecretEncrypted) {
    const secret = decryptTemuSecret(config.appSecretEncrypted)
    if (secret) credential = { appKey: config.appKey, appSecret: secret, source: "enterprise" }
  }
  cache.set(enterpriseId, { credential, at: now })
  return credential
}

const cache = new Map<string, { credential: TemuAppCredential | null; at: number }>()

/** 失效凭证缓存；不传 enterpriseId 时清空全部（企业行保存后调对应企业） */
export function resetTemuAppCredentialCache(enterpriseId?: string): void {
  if (enterpriseId == null) cache.clear()
  else cache.delete(enterpriseId)
}

/** 测试模式同样需要店铺 token：暴露测试账号的 token 供 store 录入入口提示 */
function testAccountCredential(account: TemuTestAccount): TemuAppCredential {
  return {
    appKey: account.appKey,
    appSecret: account.appSecret,
    source: "test",
  }
}
