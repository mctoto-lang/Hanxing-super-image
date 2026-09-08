import { and, eq } from "drizzle-orm"
import { db } from "@/db/client"
import { systemSettings } from "@/db/schema"
import { decrypt } from "@/lib/crypto"
import { env } from "@/lib/env"

/**
 * 样机渲染服务企业级配置（超管平台按企业配置）
 *
 * 存储：system_setting key="mockup" + enterpriseId=企业 ID。
 * 各企业对接各自的 psd-render-api 实例，模板目录天然隔离。
 * 环境变量仅作开发兜底（未配置企业级时的回退），生产以超管配置为准。
 */

export interface MockupEnterpriseConfig {
  /** 渲染服务地址（无尾斜杠） */
  apiBaseUrl: string
  /** 渲染服务 API Key（已解密） */
  apiKey: string
  /** 渲染服务 Webhook 签名密钥（已解密；与 PS-API 该 API Key 的 webhookSecret 一致，空=未启用推送） */
  webhookSecret: string
  /** 渲染单价（积分/张） */
  costPerRender: number
  enabled: boolean
}

interface MockupSettingValue {
  apiBaseUrl?: string
  /** AES-256-GCM 加密后的 API Key（encrypt() 产物） */
  apiKeyEncrypted?: string
  /** AES-256-GCM 加密后的 Webhook 签名密钥（与 PS-API 侧 API Key 的 webhookSecret 配对） */
  webhookSecretEncrypted?: string
  costPerRender?: number
  enabled?: boolean
}

/**
 * 读取企业的样机渲染配置；未配置/未启用/解密失败返回 null（页面显示未开通）。
 */
export async function loadMockupConfig(
  enterpriseId: string,
): Promise<MockupEnterpriseConfig | null> {
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(
      and(
        eq(systemSettings.key, "mockup"),
        eq(systemSettings.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)

  return row ? parseMockupConfig(row.value) : null
}

/**
 * 列举全部已启用的样机渲染企业配置（服务可用性采样遍历用）。
 */
export async function listMockupConfigs(): Promise<
  Array<MockupEnterpriseConfig & { enterpriseId: string }>
> {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "mockup"))

  const configs: Array<MockupEnterpriseConfig & { enterpriseId: string }> = []
  for (const row of rows) {
    if (!row.enterpriseId) continue // 理论不存在（企业级配置必带企业）
    const cfg = parseMockupConfig(row.value)
    if (cfg) configs.push({ ...cfg, enterpriseId: row.enterpriseId })
  }
  return configs
}

function parseMockupConfig(raw: unknown): MockupEnterpriseConfig | null {
  const v = (raw ?? {}) as MockupSettingValue

  const apiBaseUrl = (v.apiBaseUrl ?? "").replace(/\/+$/, "")
  const apiKey = v.apiKeyEncrypted
    ? safelyDecrypt(v.apiKeyEncrypted)
    : env.MOCKUP_API_KEY ?? ""
  const webhookSecret = v.webhookSecretEncrypted
    ? safelyDecrypt(v.webhookSecretEncrypted)
    : ""
  const settingCost = Number(v.costPerRender)
  const envCost = Number(env.MOCKUP_COST_PER_RENDER)
  const costPerRender =
    Number.isFinite(settingCost) && settingCost > 0
      ? Math.floor(settingCost)
      : Number.isFinite(envCost) && envCost > 0
        ? Math.floor(envCost)
        : 1

  if (!apiBaseUrl || !apiKey || v.enabled === false) return null

  return { apiBaseUrl, apiKey, webhookSecret, costPerRender, enabled: true }
}

function safelyDecrypt(payload: string): string {
  try {
    return decrypt(payload)
  } catch {
    return ""
  }
}
