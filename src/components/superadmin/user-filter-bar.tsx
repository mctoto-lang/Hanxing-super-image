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
 * 平台用户列表筛选条（客户端）：搜索 + 类型/状态/归属企业三个 Select。
 *
 * GET form（action=/platform/users）语义：Select 当前值经 hidden input
 * 随表单提交；下拉选中即 requestSubmit 自动刷新（URL 驱动，翻页 query
 * 透传），「筛选」按钮负责搜索词提交。口径同企业列表筛选条。
 */
export function UserFilterBar({
  q,
  type,
  status,
  enterpriseId,
  enterprises,
}: {
  q: string
  type: string
  status: string
  enterpriseId: string
  /** 全部企业（下拉数据源） */
  enterprises: Array<{ id: string; name: string }>
}) {
  const formRef = React.useRef<HTMLFormElement>(null)
  const [typeValue, setTypeValue] = React.useState(type)
  const [statusValue, setStatusValue] = React.useState(status)
  const [entValue, setEntValue] = React.useState(enterpriseId)

  // URL 参数外部变化（翻页带回）时同步下拉显示
  React.useEffect(() => {
    setTypeValue(type)
    setStatusValue(status)
    setEntValue(enterpriseId)
  }, [type, status, enterpriseId])

  /** 选中即提交（hidden input 由 state 驱动，渲染后提交携带新值） */
  function autoSubmit() {
    // 等 state 写入 hidden input 后再提交
    requestAnimationFrame(() => formRef.current?.requestSubmit())
  }

  return (
    <form
      ref={formRef}
      action="/platform/users"
      className="flex flex-wrap items-center gap-2"
    >
      <Input
        name="q"
        defaultValue={q}
        placeholder="搜索用户名 / 昵称 / 邮箱"
        className="w-52"
      />
      <input type="hidden" name="type" value={typeValue} />
      <Select
        value={typeValue || "__all__"}
        onValueChange={(v) => {
          setTypeValue(v === "__all__" ? "" : (v ?? ""))
          autoSubmit()
        }}
        items={[
          { value: "__all__", label: "全部类型" },
          { value: "superadmin", label: "超管" },
          { value: "enterprise", label: "企业用户" },
        ]}
      >
        <SelectTrigger className="w-fit">
          <SelectValue>
            {typeValue === "superadmin" ? "超管" : typeValue === "enterprise" ? "企业用户" : "全部类型"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">全部类型</SelectItem>
          <SelectItem value="superadmin">超管</SelectItem>
          <SelectItem value="enterprise">企业用户</SelectItem>
        </SelectContent>
      </Select>
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
          { value: "disabled", label: "已停用" },
        ]}
      >
        <SelectTrigger className="w-fit">
          <SelectValue>
            {statusValue === "active" ? "正常" : statusValue === "disabled" ? "已停用" : "全部状态"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">全部状态</SelectItem>
          <SelectItem value="active">正常</SelectItem>
          <SelectItem value="disabled">已停用</SelectItem>
        </SelectContent>
      </Select>
      <input type="hidden" name="enterpriseId" value={entValue} />
      <Select
        value={entValue || "__all__"}
        onValueChange={(v) => {
          setEntValue(v === "__all__" ? "" : (v ?? ""))
          autoSubmit()
        }}
        items={[
          { value: "__all__", label: "全部企业" },
          ...enterprises.map((e) => ({ value: e.id, label: e.name })),
        ]}
      >
        <SelectTrigger className="w-fit">
          <SelectValue>
            {entValue
              ? (enterprises.find((e) => e.id === entValue)?.name ?? "全部企业")
              : "全部企业"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">全部企业</SelectItem>
          {enterprises.map((e) => (
            <SelectItem key={e.id} value={e.id}>
              {e.name}
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
