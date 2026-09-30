"use client"

/**
 * 角色槽位下拉（Agent 配置页共用）：Label + Select + 空态提示。
 * 只渲染 SelectContent children（旧实现同时传 items prop 造成列表重复）。
 */
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function SlotSelect({
  label,
  hint,
  options,
  value,
  onChange,
  placeholder = "选择模型",
}: {
  label: string
  hint?: string
  options: { id: string; label: string }[]
  value: string | null
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">
        {label}
        {hint && <span className="ml-1 text-amber-600">{hint}</span>}
      </Label>
      {options.length === 0 ? (
        <p className="rounded-md border border-dashed p-1.5 text-[11px] text-muted-foreground">
          暂无可用模型，请先在对应模型页配置
        </p>
      ) : (
        <Select value={value ?? ""} onValueChange={(v) => v && onChange(v)}>
          <SelectTrigger size="sm" className="w-full" aria-label={label}>
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
