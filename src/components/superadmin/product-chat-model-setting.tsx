"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  saveProductChatModelSettingAction,
  type ProductChatModelOption,
} from "@/server/actions/platform-product-config"

/** 「未指定」哨兵值（shadcn Select 不接受空串 value） */
const NONE = "__none__"

/**
 * 商品主图 AI 对话模型指定（超管）
 *
 * 指定后全局强制：所有企业的商品主图 AI 帮写/智能匹配一律使用该平台预置模型；
 * 未指定、或指定行已停用/删除时回退：企业私有 → 平台预置。
 */
export function ProductChatModelSetting({
  chatApiConfigId,
  active,
  options,
}: {
  chatApiConfigId: string | null
  /** 指定行当前是否仍为活跃的平台预置模型（false=已停用/删除，回退中） */
  active: boolean
  options: ProductChatModelOption[]
}) {
  const router = useRouter()
  const initial = chatApiConfigId ?? NONE
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)
  const dirty = value !== initial

  const save = async () => {
    setSaving(true)
    try {
      const res = await saveProductChatModelSettingAction(
        value === NONE ? null : value,
      )
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success(value === NONE ? "已清除指定，恢复回退逻辑" : "已保存指定模型")
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-xl space-y-4 rounded-lg border p-4">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          指定后<strong className="text-foreground">全局强制</strong>
          ：所有企业的商品图片 AI 帮写/智能匹配一律使用该模型（仅可选平台预置的活跃模型）。
          未指定或模型失效时回退：企业私有 → 平台预置。
        </p>
        {chatApiConfigId && !active && (
          <p className="text-sm text-destructive">
            当前指定的模型已停用或删除，系统正在按回退逻辑调用。
          </p>
        )}
      </div>

      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          暂无可用的平台预置对话模型，请先到
          <Link
            href="/platform/chat-models"
            className="mx-1 underline underline-offset-2 hover:text-foreground"
          >
            对话模型管理
          </Link>
          创建并启用。
        </p>
      ) : (
        <div className="space-y-2">
          <Label>指定对话模型</Label>
          <div className="flex items-center gap-2">
            <Select value={value} onValueChange={(v) => setValue(v ?? NONE)}>
              <SelectTrigger className="w-72">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>未指定（回退：企业私有 → 平台预置）</SelectItem>
                {options.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.displayName}
                    {o.name && o.name !== o.displayName ? `（${o.name}）` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={save} disabled={!dirty || saving}>
              {saving && <MorphingInfinity className="size-4" />}
              保存
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
