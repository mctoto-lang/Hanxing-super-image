import { and, asc, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { temuApps, temuStores } from "@/db/schema"
import { decrypt, encrypt } from "@/lib/crypto"
import { TEST_ACCOUNTS } from "./test-accounts"
import { DEMO_APP_KEY } from "./demo-api"

/**
 * TEMU 官方开放平台应用凭证（多主体模型，0097 起）
 *
 * 每企业可配置多个自研应用（temu_app 表：各主体一套 app_key/secret，超管在
 * 企业管理里维护）；店铺挂到应用下（temu_store.app_id），单应用最多 20 店铺；
 * 调用凭证按「店铺 → 应用」取（getTemuAppCredential，30s 进程内缓存按 appId）。
 * 每店铺各自的 access_token 仍存 temu_store（见 store-manager）。testMode
 * 开关切换到官方文档测试账号的 app_key/secret（店铺 token 仍读店铺行）。
 */

/** temu_app 表行的调用侧投影（getTemuAppCredential 入参） */
export interface TemuAppCredentialInput {
  id: string
  appKey: string
  /** AES-256-GCM 密文（enc:v1: 前缀），空串=未配置 */
  appSecretEncrypted: string
  testMode: boolean
}

/** 调用侧拿到的明文凭证 */
export interface TemuAppCredential {
  appKey: string
  appSecret: string
  /** 凭证来源（testMode 时为测试账号，用于日志/展示） */
  source: "app" | "test"
}

export interface TemuAppRow {
  id: string
  enterpriseId: string
  name: string
  appKey: string
  appSecretEncrypted: string
  testMode: boolean
  enabled: boolean
  sortOrder: number
}

import { MAX_STORES_PER_APP } from "./constants"

// 统一出口（server 侧既有消费者；client 组件请直接 import ./constants）
export { MAX_STORES_PER_APP }

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

/* ─── 应用 CRUD（无鉴权，调用方自行守卫；均按 enterpriseId 隔离） ─── */

/** 列出企业的全部应用（按 sortOrder → createdAt） */
export async function listTemuApps(enterpriseId: string): Promise<TemuAppRow[]> {
  const rows = await db
    .select()
    .from(temuApps)
    .where(eq(temuApps.enterpriseId, enterpriseId))
    .orderBy(asc(temuApps.sortOrder), asc(temuApps.createdAt))
  return rows.map((r) => ({
    id: r.id,
    enterpriseId: r.enterpriseId,
    name: r.name,
    appKey: r.appKey,
    appSecretEncrypted: r.appSecretEncrypted,
    testMode: r.testMode,
    enabled: r.enabled,
    sortOrder: r.sortOrder,
  }))
}

export async function getTemuApp(appId: string): Promise<TemuAppRow | null> {
  const [row] = await db.select().from(temuApps).where(eq(temuApps.id, appId)).limit(1)
  if (!row) return null
  return {
    id: row.id,
    enterpriseId: row.enterpriseId,
    name: row.name,
    appKey: row.appKey,
    appSecretEncrypted: row.appSecretEncrypted,
    testMode: row.testMode,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
  }
}

/** 新建应用（secret 由调用方先 encryptTemuSecret；排到末尾） */
export async function createTemuApp(
  enterpriseId: string,
  input: { name: string; appKey: string; appSecretEncrypted: string; testMode: boolean },
): Promise<TemuAppRow> {
  const [row] = await db
    .insert(temuApps)
    .values({
      enterpriseId,
      name: input.name,
      appKey: input.appKey,
      appSecretEncrypted: input.appSecretEncrypted,
      testMode: input.testMode,
      sortOrder: 0,
    })
    .returning()
  resetTemuAppCredentialCache(row.id)
  return row
}

/** 更新应用字段（undefined=不修改该字段；改凭证相关字段后失效缓存） */
export async function updateTemuApp(
  appId: string,
  input: {
    name?: string
    appKey?: string
    appSecretEncrypted?: string
    testMode?: boolean
    enabled?: boolean
  },
): Promise<TemuAppRow> {
  const [row] = await db
    .update(temuApps)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(temuApps.id, appId))
    .returning()
  if (row) resetTemuAppCredentialCache(appId)
  return row
}

/** 删除应用（有店铺时外键阻止；调用方先查店铺数给出友好错误） */
export async function deleteTemuApp(appId: string): Promise<void> {
  await db.delete(temuApps).where(eq(temuApps.id, appId))
  resetTemuAppCredentialCache(appId)
}

/** 应用下真实店铺数（20 上限校验/删除前置校验用；不含演示店铺） */
export async function countAppStores(appId: string): Promise<number> {
  const rows = await db
    .select({ id: temuStores.id })
    .from(temuStores)
    .where(and(eq(temuStores.appId, appId), eq(temuStores.isDemo, false)))
  return rows.length
}

/**
 * 取调用凭证（按应用 id）：应用 testMode → 官方测试账号 app_key/secret；否则
 * 解密应用配置。应用不存在/已停用/未配置（无 appKey 或密文）返回 null，由调用
 * 方给出「未配置凭证」提示。30s 进程内缓存（按 appId，含应用行查询，保存时
 * 失效），避免每次 API 调用都查库解密。
 */
export async function getTemuAppCredential(appId: string): Promise<TemuAppCredential | null> {
  const hit = cache.get(appId)
  const now = Date.now()
  if (hit && now - hit.at < 30_000) return hit.credential
  const [row] = await db.select().from(temuApps).where(eq(temuApps.id, appId)).limit(1)
  let credential: TemuAppCredential | null = null
  if (row && row.enabled) {
    if (row.testMode) {
      credential = {
        appKey: TEST_ACCOUNTS.fullManaged.appKey,
        appSecret: TEST_ACCOUNTS.fullManaged.appSecret,
        source: "test",
      }
    } else if (row.appKey && row.appSecretEncrypted) {
      const secret = decryptTemuSecret(row.appSecretEncrypted)
      if (secret) credential = { appKey: row.appKey, appSecret: secret, source: "app" }
    }
  }
  cache.set(appId, { credential, at: now })
  return credential
}

const cache = new Map<string, { credential: TemuAppCredential | null; at: number }>()

/** 失效凭证缓存；不传 appId 时清空全部（应用行保存后调对应应用） */
export function resetTemuAppCredentialCache(appId?: string): void {
  if (appId == null) cache.clear()
  else cache.delete(appId)
}

/**
 * 演示模式判定：企业没有任何 TEMU 应用，且没有任何真实店铺（有历史店铺的
 * 企业不掺入演示数据，避免与真实店铺混排）。
 */
export async function isTemuDemoMode(enterpriseId: string): Promise<boolean> {
  const [apps, realStores] = await Promise.all([
    db.select({ id: temuApps.id }).from(temuApps).where(eq(temuApps.enterpriseId, enterpriseId)),
    db
      .select({ id: temuStores.id })
      .from(temuStores)
      .where(and(eq(temuStores.enterpriseId, enterpriseId), eq(temuStores.isDemo, false))),
  ])
  return apps.length === 0 && realStores.length === 0
}

/**
 * 演示店铺的调用凭证标记（虚拟数据：callTemuApi 见 DEMO_APP_KEY 直接返回
 * demo-api 虚拟响应，不发网络）。appSecret/accessToken 为占位值。
 */
export function getDemoCredential(): {
  appKey: string
  appSecret: string
  accessToken: string
} {
  return { appKey: DEMO_APP_KEY, appSecret: "demo", accessToken: "demo-token" }
}
