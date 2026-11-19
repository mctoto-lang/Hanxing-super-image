"use server"

import { and, eq, isNull } from "drizzle-orm"
import { db } from "@/db/client"
import { chatApiConfigs, models } from "@/db/schema"
import { decrypt } from "@/lib/crypto"
import { fetchUpstreamModelIds } from "@/lib/ai/upstream-models"
import {
  getCurrentEnterpriseScope,
  requireEnterpriseAdmin,
  requireSuperAdmin,
} from "@/lib/auth/session"

/**
 * 模型表单「拉取模型列表」Server Action（生图/对话、企业/平台四侧共用）。
 *
 * GET {endpoint}/v1/models（Bearer；生图 gemini 格式走 v1beta/models +
 * x-goog-api-key），返回模型 id 列表供表单下拉回填「模型标识」。密钥解析：
 * 优先用表单当前填写的 apiKey；编辑态留空时可用已保存密钥（传 modelId，
 * 按 scope 校验行归属——企业侧必须属于本企业、平台侧必须为预置行，防跨
 * 租户取密钥）。jimeng/grsai/midjourney 等私有协议无列表端点，表单侧
 * 直接不提供拉取入口。
 */
export async function fetchUpstreamModelsAction(input: {
  /** 调用方归属：enterprise=企业管理侧（owner/admin），platform=超管平台侧 */
  scope: "enterprise" | "platform"
  /** 模型种类：image=生图模型表，chat=对话模型表 */
  kind: "image" | "chat"
  endpoint: string
  apiKey?: string
  modelId?: string
  /** 生图模型接口格式（openai/chat→v1/models；gemini→v1beta/models）；对话模型缺省 openai */
  apiFormat?: "openai" | "chat" | "gemini" | "midjourney" | "jimeng" | "grsai"
}): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const endpoint = (input.endpoint ?? "").trim()
  if (!endpoint) {
    return { ok: false, error: "请先填写 API 地址" }
  }

  // 权限守卫（与各侧模型 CRUD action 同口径）；企业侧取企业 ID 供下方归属过滤
  let enterpriseId: string | null = null
  if (input.scope === "platform") {
    await requireSuperAdmin()
  } else {
    enterpriseId = getCurrentEnterpriseScope(
      await requireEnterpriseAdmin(),
    ).enterpriseId
  }

  let apiKey = (input.apiKey ?? "").trim()
  if (!apiKey && input.modelId) {
    // 编辑态留空 Key：用已存密钥拉取（按 scope 限定行归属）
    if (input.kind === "chat") {
      const [row] = await db
        .select({ key: chatApiConfigs.apiKeyEncrypted })
        .from(chatApiConfigs)
        .where(
          input.scope === "platform"
            ? and(
                eq(chatApiConfigs.id, input.modelId),
                isNull(chatApiConfigs.enterpriseId),
              )
            : and(
                eq(chatApiConfigs.id, input.modelId),
                eq(chatApiConfigs.enterpriseId, enterpriseId!),
              ),
        )
        .limit(1)
      if (row) apiKey = decrypt(row.key)
    } else {
      const [row] = await db
        .select({ key: models.apiKeyEncrypted })
        .from(models)
        .where(
          input.scope === "platform"
            ? and(eq(models.id, input.modelId), isNull(models.enterpriseId))
            : and(
                eq(models.id, input.modelId),
                eq(models.enterpriseId, enterpriseId!),
              ),
        )
        .limit(1)
      if (row) apiKey = decrypt(row.key)
    }
  }
  if (!apiKey) {
    return {
      ok: false,
      error: "请先填写 API Key（编辑已保存过密钥的模型时可留空自动使用）",
    }
  }

  try {
    const list = await fetchUpstreamModelIds({
      endpoint,
      apiKey,
      protocol: input.apiFormat === "gemini" ? "gemini" : "openai",
    })
    return { ok: true, models: list }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "拉取模型列表失败",
    }
  }
}
