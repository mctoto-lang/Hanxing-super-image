import { requireUserContext } from "@/lib/auth/session"
import {
  listWeartryDirectionsAction,
  listWeartryModelsAction,
  listWeartryScenesAction,
} from "@/server/actions/weartry"
import { WeartryClient } from "@/components/weartry/weartry-client"

export const dynamic = "force-dynamic"

/**
 * 穿戴图片页（四 tab：服装组图 / 模特穿戴 / AI万戴 / AI换色 + 生成历史）
 *
 * 页面骨架与商品图片页同构；访问控制走模块链（企业 enabledModules ∩
 * 权限组 allowedPages，侧边栏/模块开关控制入口）。
 */
export default async function WeartryPage() {
  const ctx = await requireUserContext()
  const [models, directions, scenes] = await Promise.all([
    listWeartryModelsAction(),
    listWeartryDirectionsAction(),
    listWeartryScenesAction(),
  ])

  return (
    <WeartryClient
      initialModels={models}
      directions={directions}
      scenes={scenes}
      creditsBalance={ctx.user.creditsBalance}
    />
  )
}
