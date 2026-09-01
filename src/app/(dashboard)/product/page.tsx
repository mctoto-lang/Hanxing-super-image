import { requireUserContext } from "@/lib/auth/session"
import {
  listPlatformSizeSpecsAction,
  listProductDirectionsAction,
  listProductLanguagesAction,
  listProductPlatformsAction,
  listProductV2ModelsAction,
} from "@/server/actions/product-v2"
import { ProductClient } from "@/components/product-v2/product-client"

export const dynamic = "force-dynamic"

export default async function ProductPage() {
  const ctx = await requireUserContext()
  const [
    models,
    suiteDirections,
    detailDirections,
    refineDirections,
    sizeSpecs,
    platforms,
    languages,
  ] = await Promise.all([
    listProductV2ModelsAction(),
    listProductDirectionsAction("suite"),
    listProductDirectionsAction("detail"),
    listProductDirectionsAction("refine"),
    listPlatformSizeSpecsAction(),
    listProductPlatformsAction(),
    listProductLanguagesAction(),
  ])

  return (
    <ProductClient
      initialModels={models}
      suiteDirections={suiteDirections}
      detailDirections={detailDirections}
      refineDirections={refineDirections}
      sizeSpecs={sizeSpecs}
      platforms={platforms}
      languages={languages}
      creditsBalance={ctx.user.creditsBalance}
    />
  )
}
