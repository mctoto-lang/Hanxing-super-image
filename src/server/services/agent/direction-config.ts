/**
 * 方向配置读取（完整形状，含 templateConfig）
 *
 * 与 actions/agent.ts 内的 loadDirectionConfig 的差异：本模块面向模板化
 * 流程，templateConfig 缺行/缺列时回退内置默认（defaultTemplateConfigFor），
 * 供生产图构造（buildTemplateProductionGraph）与配置完整性校验使用。
 */
import { eq } from "drizzle-orm"
import { db } from "@/db/client"
import { agentDirectionConfigs } from "@/db/schema"
import {
  DEFAULT_DIRECTION_CONFIGS,
  defaultTemplateConfigFor,
  type DirectionConfig,
} from "@/lib/agent/pipelines"
import type { AgentDirection } from "@/lib/agent/graph"

export async function loadFullDirectionConfig(direction: AgentDirection): Promise<DirectionConfig> {
  const fallback = DEFAULT_DIRECTION_CONFIGS.find((item) => item.direction === direction)!
  const [row] = await db
    .select()
    .from(agentDirectionConfigs)
    .where(eq(agentDirectionConfigs.direction, direction))
  // 旧行缺新字段（如 copywriterChatModelId）时以内置默认补齐
  const defaults = defaultTemplateConfigFor(direction)
  if (!row) {
    return { ...fallback, templateConfig: defaults ?? undefined }
  }
  return {
    direction: row.direction,
    enabled: row.enabled,
    sampleEnabled: row.sampleEnabled,
    sampleCount: row.sampleCount,
    maxRetries: row.maxRetries,
    thresholds: row.thresholds,
    models: row.models as DirectionConfig["models"],
    templateConfig:
      defaults && row.templateConfig
        ? { ...defaults, ...(row.templateConfig as DirectionConfig["templateConfig"]) }
        : ((row.templateConfig as DirectionConfig["templateConfig"] | null) ?? defaults ?? undefined),
  }
}
