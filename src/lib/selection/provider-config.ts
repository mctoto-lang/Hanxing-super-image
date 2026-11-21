import { eq, sql } from "drizzle-orm"
import { db } from "@/db/client"
import { selectionProviders, selectionTasks } from "@/db/schema"
import { decrypt, encrypt } from "@/lib/crypto"
import { env } from "@/lib/env"

/**
 * 企业级 Apify 抓取凭证（selection_provider，每企业最多一行）
 *
 * 仿 temu-api/app-config 模式：token AES-256-GCM 加密存储（enc:v1: 前缀），
 * 超管在企业管理里维护。解析顺序：企业 provider token → 平台级
 * APIFY_API_TOKEN 兜底 → null（无可用凭证）。
 * 任务提交时快照 providerId（selection_task.provider_id），worker 启动/收割
 * 均按任务快照解析——dataset 归属启动 run 的账号，跨账号不可读，不能中途换。
 */

const TOKEN_ENC_PREFIX = "enc:v1:"
const TOKEN_MASK_PREFIX = "••••••"

export function encryptSelectionToken(plain: string): string {
  if (!plain) return ""
  return TOKEN_ENC_PREFIX + encrypt(plain)
}

export function decryptSelectionToken(stored: string): string {
  if (!stored) return ""
  if (!stored.startsWith(TOKEN_ENC_PREFIX)) return stored
  try {
    return decrypt(stored.slice(TOKEN_ENC_PREFIX.length))
  } catch (err) {
    console.error(
      "[selection] apify token 解密失败（ENCRYPTION_KEY 轮换后未重加密？）：",
      err instanceof Error ? err.message : err,
    )
    return ""
  }
}

/** 超管回显掩码：仅保留明文尾 4 位；保存时原样提交视为「未修改」 */
export function maskSelectionToken(plain: string): string {
  if (!plain) return ""
  return `${TOKEN_MASK_PREFIX}${plain.slice(-4)}`
}

const MASK_RE = new RegExp(`^${TOKEN_MASK_PREFIX}`)

/** 掩码前缀判定（保存时原样提交=未修改旧 token） */
export function isMaskedSelectionToken(value: string): boolean {
  return MASK_RE.test(value)
}

export interface SelectionProviderRow {
  id: string
  enterpriseId: string
  name: string
  tokenEncrypted: string
  enabled: boolean
}

function toRow(r: typeof selectionProviders.$inferSelect): SelectionProviderRow {
  return {
    id: r.id,
    enterpriseId: r.enterpriseId,
    name: r.name,
    tokenEncrypted: r.tokenEncrypted,
    enabled: r.enabled,
  }
}

/** 取企业唯一的 provider 行（无则 null） */
export async function getSelectionProvider(
  enterpriseId: string,
): Promise<SelectionProviderRow | null> {
  const [row] = await db
    .select()
    .from(selectionProviders)
    .where(eq(selectionProviders.enterpriseId, enterpriseId))
    .limit(1)
  return row ? toRow(row) : null
}

export async function getSelectionProviderById(
  providerId: string,
): Promise<SelectionProviderRow | null> {
  const [row] = await db
    .select()
    .from(selectionProviders)
    .where(eq(selectionProviders.id, providerId))
    .limit(1)
  return row ? toRow(row) : null
}

/** 保存（每企业 upsert 单行；token 为空串=清除；掩码原样提交=保留旧值） */
export async function saveSelectionProvider(
  enterpriseId: string,
  input: { name: string; tokenEncrypted: string; enabled: boolean },
): Promise<SelectionProviderRow> {
  const [row] = await db
    .insert(selectionProviders)
    .values({
      enterpriseId,
      name: input.name,
      tokenEncrypted: input.tokenEncrypted,
      enabled: input.enabled,
    })
    .onConflictDoUpdate({
      target: selectionProviders.enterpriseId,
      set: {
        name: input.name,
        tokenEncrypted: input.tokenEncrypted,
        enabled: input.enabled,
        updatedAt: new Date(),
      },
    })
    .returning()
  resetSelectionTokenCache()
  return toRow(row)
}

/** 仍引用该凭证的任务数（删除前置校验：>0 时拒绝，提示改用停用） */
export async function countProviderTasks(providerId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(selectionTasks)
    .where(eq(selectionTasks.providerId, providerId))
  return n
}

/**
 * 删除 provider 行（调用方先 countProviderTasks 守卫）
 */
export async function deleteSelectionProvider(providerId: string): Promise<void> {
  await db.delete(selectionProviders).where(eq(selectionProviders.id, providerId))
  resetSelectionTokenCache()
}

/** 解析结果：明文 token + 来源（日志/错误提示用） */
export interface ResolvedSelectionToken {
  token: string
  source: "provider" | "platform"
  providerId: string | null
}

/**
 * 按 providerId（任务快照路径）或 enterpriseId（提交前校验路径）解析可用 token：
 * 企业 provider（存在+enabled+已配置）→ 平台 APIFY_API_TOKEN 兜底 → null。
 * 30s 进程内缓存（保存/删除 provider 时整体失效），避免每任务每轮查库解密。
 */
export async function resolveSelectionToken(input: {
  providerId?: string | null
  enterpriseId?: string | null
}): Promise<ResolvedSelectionToken | null> {
  const cacheKey =
    input.providerId != null ? `p:${input.providerId}` : `e:${input.enterpriseId ?? ""}`
  const hit = tokenCache.get(cacheKey)
  const now = Date.now()
  if (hit && now - hit.at < 30_000) return hit.resolved

  let provider: SelectionProviderRow | null = null
  if (input.providerId != null) provider = await getSelectionProviderById(input.providerId)
  else if (input.enterpriseId != null) provider = await getSelectionProvider(input.enterpriseId)

  let resolved: ResolvedSelectionToken | null = null
  if (provider && provider.enabled && provider.tokenEncrypted) {
    const token = decryptSelectionToken(provider.tokenEncrypted)
    if (token) resolved = { token, source: "provider", providerId: provider.id }
  }
  if (!resolved && env.APIFY_API_TOKEN) {
    resolved = { token: env.APIFY_API_TOKEN, source: "platform", providerId: null }
  }
  tokenCache.set(cacheKey, { resolved, at: now })
  return resolved
}

/** 企业是否有任何可用抓取凭证（提交入口 UI 提示用） */
export async function hasSelectionToken(enterpriseId: string): Promise<boolean> {
  return (await resolveSelectionToken({ enterpriseId })) != null
}

const tokenCache = new Map<string, { resolved: ResolvedSelectionToken | null; at: number }>()

/** 失效 token 缓存（provider 保存/删除后调用；规模小直接清空） */
export function resetSelectionTokenCache(): void {
  tokenCache.clear()
}
