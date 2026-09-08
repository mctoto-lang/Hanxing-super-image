"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"

/** 权限组模型白名单勾选器的模型选项（生图/对话通用） */
export interface GroupModelOption {
  id: string
  displayName: string
  isActive: boolean
  isPreset: boolean // true=平台预置，false=企业私有
}

/**
 * 权限组模型白名单勾选区（生图/对话模型各一份）。
 * 语义：不勾选 = 放行企业全部可用模型；勾选后仅勾选项对本组可见可用。
 */
export function GroupModelPicker({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: GroupModelOption[]
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
}) {
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selected)
    if (checked) next.add(id)
    else next.delete(id)
    onChange(next)
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}（不勾选默认放行企业全部可用模型）</Label>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={options.length === 0}
            onClick={() => onChange(new Set(options.map((o) => o.id)))}
          >
            全选
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={selected.size === 0}
            onClick={() => onChange(new Set())}
          >
            清空
          </Button>
        </div>
      </div>
      <div className="max-h-44 overflow-y-auto rounded-md border p-3">
        {options.length === 0 ? (
          <p className="py-2 text-center text-sm text-muted-foreground">
            企业暂无可用模型
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {options.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selected.has(o.id)}
                  onCheckedChange={(checked) => toggle(o.id, checked)}
                />
                <span className="min-w-0 truncate" title={o.displayName}>
                  {o.displayName}
                </span>
                {!o.isActive ? (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    停用
                  </Badge>
                ) : null}
              </label>
            ))}
          </div>
        )}
      </div>
      {selected.size > 0 ? (
        <p className="text-xs text-muted-foreground">
          已选 {selected.size} / {options.length}，未勾选的模型对本组成员不可见
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          未限制：本组可用企业全部可用模型
        </p>
      )}
    </div>
  )
}
