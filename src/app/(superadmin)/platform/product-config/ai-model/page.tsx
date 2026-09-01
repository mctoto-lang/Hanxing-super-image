import { requireSuperAdmin } from "@/lib/auth/session"
import { getProductChatModelSettingAction } from "@/server/actions/platform-product-config"
import { ProductChatModelSetting } from "@/components/superadmin/product-chat-model-setting"

export const dynamic = "force-dynamic"

/** 商品主图配置 → AI 对话模型（指定商品主图 AI 帮写/智能匹配的调用模型） */
export default async function ProductAiModelConfigPage() {
  await requireSuperAdmin()
  const setting = await getProductChatModelSettingAction()

  return (
    <div className="space-y-4">
      <ProductChatModelSetting {...setting} />
    </div>
  )
}
