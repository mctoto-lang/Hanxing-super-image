import { and, desc, eq, isNull } from "drizzle-orm"
import { db } from "@/db/client"
import { chatApiConfigs, systemSettings, type SystemSettingValue } from "@/db/schema"

/**
 * 商品主图 AI（帮写/智能匹配）对话模型解析
 *
 * 超管可在「商品主图配置 → AI 对话模型」指定一个平台预置对话模型，
 * 指定后全局强制：所有企业的商品主图 AI 调用一律使用该模型；
 * 未指定、或指定行已删除/停用时回退旧逻辑（企业私有 → 平台预置任一活跃行）。
 *
 * 存储复用 system_setting（平台级，key=product_ai_chat_model，value={chatApiConfigId}），
 * 读写策略与 platform-system.ts 一致（最新行优先、先 UPDATE 后 INSERT，
 * 规避 unique(key, enterpriseId) 对 NULL 不去重的坑）。
 */

const SETTING_KEY = "product_ai_chat_model"

/** 读指定模型 id（未指定 → null） */
export async function getDesignatedProductChatModelId(): Promise<string | null> {
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(
      and(eq(systemSettings.key, SETTING_KEY), isNull(systemSettings.enterpriseId)),
    )
    .orderBy(desc(systemSettings.updatedAt))
    .limit(1)
  const id = (
    row?.value as { chatApiConfigId?: unknown } | undefined
  )?.chatApiConfigId
  return typeof id === "string" && id ? id : null
}

/** 写指定模型 id（null = 清除指定，恢复回退逻辑） */
export async function saveDesignatedProductChatModelId(
  chatApiConfigId: string | null,
): Promise<void> {
  // 与 platform-system.ts 同款：value 存纯 payload，双断言过 SystemSettingValue 类型
  const value = { chatApiConfigId } as unknown as SystemSettingValue
  const updated = await db
    .update(systemSettings)
    .set({ value, updatedAt: new Date() })
    .where(
      and(eq(systemSettings.key, SETTING_KEY), isNull(systemSettings.enterpriseId)),
    )
    .returning({ id: systemSettings.id })
  if (updated.length === 0) {
    await db.insert(systemSettings).values({
      enterpriseId: null,
      key: SETTING_KEY,
      value,
      description: "商品图片 AI 指定对话模型（全局强制）",
    })
  }
}

/**
 * 解析商品主图 AI 用的对话模型配置：
 * 超管指定（须为活跃的平台预置行）→ 企业私有 → 平台预置；无 → null
 *
 * 仅返回 openai 兼容格式行：内部提示词操作走旧 callChatApi（OpenAI
 * 兼容专用），claude/gemini/grok 格式仅供 /chat 交互对话使用。
 */
export async function resolveProductChatConfig(enterpriseId: string) {
  const designatedId = await getDesignatedProductChatModelId()
  if (designatedId) {
    const [row] = await db
      .select()
      .from(chatApiConfigs)
      .where(
        and(
          eq(chatApiConfigs.id, designatedId),
          eq(chatApiConfigs.isActive, true),
          eq(chatApiConfigs.formatType, "openai"),
          isNull(chatApiConfigs.enterpriseId),
        ),
      )
      .limit(1)
    if (row) return row
  }
  const [entRow] = await db
    .select()
    .from(chatApiConfigs)
    .where(
      and(
        eq(chatApiConfigs.isActive, true),
        eq(chatApiConfigs.formatType, "openai"),
        eq(chatApiConfigs.enterpriseId, enterpriseId),
      ),
    )
    .limit(1)
  if (entRow) return entRow
  const [platformRow] = await db
    .select()
    .from(chatApiConfigs)
    .where(
      and(
        eq(chatApiConfigs.isActive, true),
        eq(chatApiConfigs.formatType, "openai"),
        isNull(chatApiConfigs.enterpriseId),
      ),
    )
    .limit(1)
  return platformRow ?? null
}
