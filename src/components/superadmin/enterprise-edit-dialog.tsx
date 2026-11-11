"use client"

import * as React from "react"
import { Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useForm } from "react-hook-form"
import type { z } from "zod"
import { enterpriseInfoFormSchema } from "@/lib/forms/schemas"
import { AvatarUpload } from "@/components/shared/avatar-upload"
import { updateEnterpriseInfoAction } from "@/server/actions/platform"

/**
 * 企业信息编辑弹窗（超管）：名称 / Slug / Logo。
 *
 * - Logo 上传走 /api/upload/avatar（category=config 不过期），保存时落
 *   enterprises.logoUrl（此前该字段只有侧边栏展示、无任何写入入口）；
 * - Slug 修改有唯一性校验（后端排除自身）；
 * - 仅提交有变更的字段。
 */
type EnterpriseInfoValues = z.infer<typeof enterpriseInfoFormSchema>

export function EnterpriseEditDialog({
  enterpriseId,
  enterpriseName,
  slug,
  logoUrl,
  size = "sm",
}: {
  enterpriseId: string
  enterpriseName: string
  slug: string
  logoUrl: string | null
  /** 详情页头部传 "default"，列表行内用缺省 sm */
  size?: "sm" | "default"
}) {
  const [open, setOpen] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const router = useRouter()

  const form = useForm<EnterpriseInfoValues>({
    resolver: standardSchemaResolver(enterpriseInfoFormSchema),
    defaultValues: { name: enterpriseName, slug, logoUrl },
  })
  const pending = form.formState.isSubmitting

  React.useEffect(() => {
    if (open) {
      form.reset({ name: enterpriseName, slug, logoUrl })
      setServerError(null)
    }
  }, [open, form, enterpriseName, slug, logoUrl])

  async function onSubmit(values: EnterpriseInfoValues) {
    setServerError(null)
    // 仅提交有变更的字段（与改造前 diff 口径一致）
    const res = await updateEnterpriseInfoAction({
      enterpriseId,
      ...(values.name !== enterpriseName ? { name: values.name } : {}),
      ...(values.slug !== slug ? { slug: values.slug } : {}),
      ...(values.logoUrl !== logoUrl ? { logoUrl: values.logoUrl ?? null } : {}),
    })
    if (res.ok) {
      toast.success("企业信息已更新")
      setOpen(false)
      router.refresh()
      return
    }
    // 服务端兜底错误：统一条内联展示，不再 toast
    setServerError(res.error ?? "保存失败")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size={size}>
            <Pencil className="size-3.5" />
            编辑信息
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>编辑企业信息</DialogTitle>
          <DialogDescription>{enterpriseName}（{slug}）</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>企业名称</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={100} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="slug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Slug</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={50} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    只能含小写字母、数字、短横线；修改后需保证全平台唯一
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="logoUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>企业 Logo</FormLabel>
                  <FormControl>
                    <AvatarUpload
                      imageUrl={field.value ?? null}
                      onChange={(url) => field.onChange(url)}
                      fallbackText={enterpriseName}
                      disabled={pending}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    展示于成员侧边栏企业徽章处，保存后生效
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            {serverError ? (
              <p className="text-sm text-destructive">{serverError}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "保存中…" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
