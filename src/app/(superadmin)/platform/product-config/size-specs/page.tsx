import { requireSuperAdmin } from "@/lib/auth/session"
import { listSizeSpecsAction } from "@/server/actions/platform-product"
import { SizeSpecFormDialog } from "@/components/superadmin/size-spec-form-dialog"
import type { SizeSpecRow } from "@/components/superadmin/size-spec-form-dialog"
import { SizeSpecsTable } from "@/components/superadmin/size-specs-table"

export const dynamic = "force-dynamic"

export default async function SizeSpecsPage() {
  await requireSuperAdmin()
  const specs: SizeSpecRow[] = await listSizeSpecsAction()

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">平台尺寸规范</h2>
          <p className="text-sm text-muted-foreground">
            平台有具体尺寸规范的出图尺寸（如 Amazon A+ 模块）；「图片比例」下拉的数据源
          </p>
        </div>
        <SizeSpecFormDialog />
      </div>

      {specs.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无尺寸规范，请点击右上角新增（或运行 pnpm seed:product-v2）
        </div>
      ) : (
        <SizeSpecsTable specs={specs} />
      )}
    </div>
  )
}
