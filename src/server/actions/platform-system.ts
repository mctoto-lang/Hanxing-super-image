"use server"

import { and, desc, eq, isNull } from "drizzle-orm"
import { db } from "@/db/client"
import { systemSettings, type SystemSettingValue } from "@/db/schema"
import { requireSuperAdmin } from "@/lib/auth/session"
import {
  encryptStorageSecret,
  loadStorageConfig,
  maskStorageSecret,
  type StorageConfig,
} from "@/lib/storage/config"
import { revalidatePath } from "next/cache"

/**
 * 平台系统设置 Server Actions（手册 M7、§4.4）
 *
 * 仅超管可操作。平台级设置 enterpriseId=NULL。
 * 当前支持：storage（存储后端）、queue（队列阈值）。
 *
 * ⚠️ unique(key, enterpriseId) 对 NULL 不去重（Postgres NULL≠NULL），历史保存
 * 用 onConflictDoUpdate 永远命不中 NULL 行，会不断插入重复行——读写都必须
 * 按 updatedAt 最新优先保证确定性，写入改为先 UPDATE 后 INSERT。
 */

/** 读平台级设置（最新一行优先） */
async function readPlatformSetting(key: string) {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(
      and(eq(systemSettings.key, key), isNull(systemSettings.enterpriseId)),
    )
    .orderBy(desc(systemSettings.updatedAt))
    .limit(1)
  return row
}

/** 写平台级设置：UPDATE 命中现有行（含历史重复行，统一覆盖），无行才 INSERT */
async function upsertPlatformSetting(
  key: string,
  value: SystemSettingValue,
  description: string,
): Promise<void> {
  const updated = await db
    .update(systemSettings)
    .set({ value, updatedAt: new Date() })
    .where(
      and(eq(systemSettings.key, key), isNull(systemSettings.enterpriseId)),
    )
    .returning({ id: systemSettings.id })
  if (updated.length === 0) {
    await db
      .insert(systemSettings)
      .values({ enterpriseId: null, key, value, description })
  }
}

/** 读取一个平台级设置 */
export async function getSettingAction(
  key: string,
): Promise<SystemSettingValue | null> {
  await requireSuperAdmin()
  const row = await readPlatformSetting(key)
  return row?.value ?? null
}

/** 读取全部平台级设置 */
export async function listSettingsAction(): Promise<
  Array<{ key: string; value: SystemSettingValue; description: string | null }>
> {
  await requireSuperAdmin()
  const rows = await db
    .select({
      key: systemSettings.key,
      value: systemSettings.value,
      description: systemSettings.description,
    })
    .from(systemSettings)
    .where(isNull(systemSettings.enterpriseId))
  return rows
}

/** 存储配置（双桶结构，与 src/lib/storage/config.ts 的 StorageConfig 一致） */
export type StorageSetting = StorageConfig

export interface QueueSetting {
  pollIntervalMs: number
  maxConcurrentPerEnterprise: number
  taskTimeoutSec: number
}

/** 获取存储设置（读 system_setting，向后兼容旧单桶配置；SecretKey 回显掩码） */
export async function getStorageSettingAction(): Promise<StorageSetting> {
  await requireSuperAdmin()
  const cfg = await loadStorageConfig()
  return { ...cfg, cosSecretKey: maskStorageSecret(cfg.cosSecretKey) }
}

/** 保存存储设置 */
export async function saveStorageSettingAction(
  input: StorageSetting,
): Promise<{ ok: boolean; error?: string }> {
  await requireSuperAdmin()
  // SecretKey AES-256-GCM 加密落库（同 API Key 策略，DB 备份/只读账号不泄密）：
  // - 表单未修改（原样提交掩码）→ 保留现值，顺带把历史明文升级为密文；
  // - 提交新值 → 加密；提交空串 → 清空（切换回 local 存储时使用）
  let secretKeyToStore: string
  if (input.cosSecretKey.startsWith("••••••")) {
    const current = await loadStorageConfig()
    secretKeyToStore = encryptStorageSecret(current.cosSecretKey)
  } else {
    secretKeyToStore = encryptStorageSecret(input.cosSecretKey)
  }
  await upsertPlatformSetting(
    "storage",
    { ...input, cosSecretKey: secretKeyToStore } as unknown as SystemSettingValue,
    "存储后端配置（local/cos）",
  )
  revalidatePath("/platform/system")
  return { ok: true }
}

/** 获取队列设置 */
export async function getQueueSettingAction(): Promise<QueueSetting> {
  await requireSuperAdmin()
  const value = await getSettingAction("queue")
  return {
    pollIntervalMs: (value?.pollIntervalMs as number) ?? 2000,
    maxConcurrentPerEnterprise:
      (value?.maxConcurrentPerEnterprise as number) ?? 5,
    taskTimeoutSec: (value?.taskTimeoutSec as number) ?? 120,
  }
}

/** 保存队列设置 */
export async function saveQueueSettingAction(
  input: QueueSetting,
): Promise<{ ok: boolean; error?: string }> {
  await requireSuperAdmin()
  await upsertPlatformSetting(
    "queue",
    input as unknown as SystemSettingValue,
    "队列参数（轮询间隔/并发上限/超时）",
  )
  revalidatePath("/platform/system")
  return { ok: true }
}
