import { requireSuperAdmin } from "@/lib/auth/session"
import { listLanguagesConfigAction } from "@/server/actions/platform-product-config"
import { LanguageFormDialog } from "@/components/superadmin/language-config-dialogs"
import type { LanguageConfigRow } from "@/components/superadmin/language-config-dialogs"
import { LanguagesConfigTable } from "@/components/superadmin/languages-config-table"

export const dynamic = "force-dynamic"

export default async function ProductLanguagesConfigPage() {
  await requireSuperAdmin()
  const languages = (await listLanguagesConfigAction()) as LanguageConfigRow[]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          控制生图图内文字语言与 AI 帮写输出语言；表空时回退内置常量
        </p>
        <LanguageFormDialog />
      </div>

      <LanguagesConfigTable languages={languages} />
    </div>
  )
}
