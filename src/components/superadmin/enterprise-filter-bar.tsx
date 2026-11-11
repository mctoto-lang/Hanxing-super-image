"use client"

import * as React from "react"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * 企业管理列表筛选条（客户端）：搜索 + 状态/套餐/排序三个 shadcn Select。
 *
 * GET form（action=/platform/enterprises）语义保留：Select 当前值经
 * hidden input 随表单提交；**下拉选中即 requestSubmit 自动刷新**
 * （URL 驱动，翻页 query 透传），「筛选」按钮负责搜索词提交。
 * 控件统一 h-8（SelectTrigger default / Input / Button default），与全站 Select 风格一致。
 */

/** 排序选项（与 listEnterprisesAction 的 sort 入参一致，默认最新创建在前） */
const SORT_OPTIONS = [
  { value: "createdAt_desc", label: "最新创建" },
  { value: "createdAt_asc", label: "最早创建" },
  { value: "credits_desc", label: "积分余额" },
] as const

export function EnterpriseFilterBar({
  q,
  status,
  plan,
  sort,
  plans,
}: {
  q: string
  status: string
  plan: string
  sort: string
  /** 全部套餐（下拉数据源） */
  plans: Array<{ id: string; name: string }>
}) {
  const formRef = React.useRef<HTMLFormElement>(null)
  const [statusValue, setStatusValue] = React.useState(status)
  const [planValue, setPlanValue] = React.useState(plan)
  const [sortValue, setSortValue] = React.useState(sort)

  // URL 参数外部变化（翻页带回）时同步下拉显示
  React.useEffect(() => {
    setStatusValue(status)
    setPlanValue(plan)
    setSortValue(sort)
  }, [status, plan, sort])

  /** 选中即提交（hidden input 由 state 驱动，渲染后提交携带新值） */
  function autoSubmit() {
    // 等 state 写入 hidden input 后再提交
    requestAnimationFrame(() => formRef.current?.requestSubmit())
  }

  return (
    <form
      ref={formRef}
      action="/platform/enterprises"
      className="flex flex-wrap items-center gap-2"
    >
      <Input
        name="q"
        defaultValue={q}
        placeholder="搜索企业名 / Slug"
        className="w-52"
      />
      <input type="hidden" name="status" value={statusValue} />
      <Select
        value={statusValue || "__all__"}
        onValueChange={(v) => {
          setStatusValue(v === "__all__" ? "" : (v ?? ""))
          autoSubmit()
        }}
        items={[
          { value: "__all__", label: "全部状态" },
          { value: "active", label: "正常" },
          { value: "suspended", label: "已停用" },
        ]}
      >
        <SelectTrigger className="w-fit">
          <SelectValue>
            {statusValue === "active" ? "正常" : statusValue === "suspended" ? "已停用" : "全部状态"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">全部状态</SelectItem>
          <SelectItem value="active">正常</SelectItem>
          <SelectItem value="suspended">已停用</SelectItem>
        </SelectContent>
      </Select>
      <input type="hidden" name="plan" value={planValue} />
      <Select
        value={planValue || "__all__"}
        onValueChange={(v) => {
          setPlanValue(v === "__all__" ? "" : (v ?? ""))
          autoSubmit()
        }}
        items={[
          { value: "__all__", label: "全部套餐" },
          { value: "none", label: "免费版（未分配）" },
          ...plans.map((p) => ({ value: p.id, label: p.name })),
        ]}
      >
        <SelectTrigger className="w-fit">
          <SelectValue>
            {planValue === "none"
              ? "免费版（未分配）"
              : planValue
                ? (plans.find((p) => p.id === planValue)?.name ?? "全部套餐")
                : "全部套餐"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">全部套餐</SelectItem>
          <SelectItem value="none">免费版（未分配）</SelectItem>
          {plans.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input type="hidden" name="sort" value={sortValue} />
      <Select
        value={sortValue}
        onValueChange={(v) => {
          setSortValue(v ?? "createdAt_desc")
          autoSubmit()
        }}
        items={SORT_OPTIONS.map((o) => ({ value: o.value, label: `排序：${o.label}` }))}
      >
        <SelectTrigger className="w-fit">
          <SelectValue>
            排序：{SORT_OPTIONS.find((o) => o.value === sortValue)?.label ?? "最新创建"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              排序：{o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="submit" variant="outline">
        <Search className="size-3.5" />
        筛选
      </Button>
    </form>
  )
}
