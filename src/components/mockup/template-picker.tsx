"use client"

import * as React from "react"
import { Image as ImageIcon, RefreshCw, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { SmartImage } from "@/components/ui/smart-image"
import type { MockupExternalTemplateView } from "@/lib/mockup/types"

/**
 * 模板选择共用组件（创建卡片 / 模板管理 / 批量替换 三处复用）
 *
 * ExternalTemplateCard = 外部小模板卡片：缩略图（代理拉取）+ 名称 + 归属人 +
 * 可见性徽章；勾选态（套组成员选择）与底部操作按钮由调用方按需注入。
 */

/** 模板缩略图代理地址（外部无缩略图/未加端点时 onError 占位） */
export function thumbnailSrc(templateId: string) {
  return `/api/mockup/template-thumbnail?templateId=${encodeURIComponent(templateId)}`
}

/** 可见性徽章（public=企业内可见 / private=仅归属人与管理员） */
export function VisibilityBadge({
  visibility,
}: {
  visibility: "public" | "private"
}) {
  return visibility === "private" ? (
    <span className="rounded bg-amber-500/15 px-1 py-px text-[9px] text-amber-600">
      私有
    </span>
  ) : (
    <span className="rounded bg-emerald-500/15 px-1 py-px text-[9px] text-emerald-600">
      公开
    </span>
  )
}

/** 归属人标签（外部平台共享模板显示「平台」） */
export function OwnerLabel({ name }: { name: string | null | undefined }) {
  return (
    <span className="truncate text-[10px] text-muted-foreground" title={name ?? undefined}>
      {name ? `归属：${name}` : "归属：平台"}
    </span>
  )
}

export function TemplateThumb({
  templateId,
  hasThumbnail,
  directUrl,
  className,
}: {
  templateId: string
  hasThumbnail: boolean
  /** 预签名直链（优先，浏览器直连渲染服务；缺失走本应用代理路由） */
  directUrl?: string | null
  className?: string
}) {
  const [attempt, setAttempt] = React.useState(0)
  const [errored, setErrored] = React.useState(false)

  // 加载链：直链重试 2 次 → 代理路由重试 2 次 → 占位图标。
  // 直链的瞬时抖动（签名过期/TTL 内网络闪断）由代理兜底；代理回源抖动
  // （排队/限流）由延迟重试自愈。key 变化强制 SmartImage 重挂载重新拉取。
  React.useEffect(() => {
    if (!errored || attempt >= 4) return
    const timer = setTimeout(() => {
      setAttempt((a) => a + 1)
      setErrored(false)
    }, 1000 * ((attempt % 2) + 1))
    return () => clearTimeout(timer)
  }, [errored, attempt])

  if (!hasThumbnail || (errored && attempt >= 4)) {
    return (
      <span
        className={`flex aspect-square items-center justify-center bg-muted/50 ${className ?? ""}`}
      >
        <ImageIcon className="size-6 text-muted-foreground/40" />
      </span>
    )
  }
  const src =
    directUrl && attempt < 2
      ? directUrl
      : thumbnailSrc(templateId)
  return (
    <SmartImage
      key={`${attempt}-${src}`}
      src={src}
      alt="模板缩略图"
      className={`aspect-square w-full object-cover ${className ?? ""}`}
      onError={() => setErrored(true)}
    />
  )
}

/** 外部模板状态 → 中文（statusLabel 为外部服务原文，可能是英文） */
const TEMPLATE_STATUS_CN: Record<string, string> = {
  DRAFT: "草稿",
  PUBLISHED: "已发布",
  ARCHIVED: "已归档",
}

function templateStatusCn(template: MockupExternalTemplateView): string {
  if (template.published) return "已发布"
  return (
    TEMPLATE_STATUS_CN[template.status?.toUpperCase()] ?? template.statusLabel
  )
}

export function ExternalTemplateCard({
  template,
  checked,
  onToggle,
  onClick,
  selected,
  footer,
}: {
  template: MockupExternalTemplateView
  /** 勾选态（套组成员选择） */
  checked?: boolean
  onToggle?: () => void
  /** 点击缩略图（不带勾选框，如模板管理点击进入编辑绑定） */
  onClick?: () => void
  /** 选中态（选择器单选高亮） */
  selected?: boolean
  /** 底部操作区（编辑绑定/生成缩略图/批量替换等，由调用方注入） */
  footer?: React.ReactNode
}) {
  const thumbClick = onToggle ?? onClick
  return (
    <div
      className={`relative flex w-full flex-col overflow-hidden rounded-lg border bg-card transition ${
        checked || selected ? "border-primary ring-1 ring-primary/40" : ""
      }`}
    >
      {thumbClick ? (
        <button
          type="button"
          className="block text-left"
          onClick={thumbClick}
          title={template.name}
        >
          <TemplateThumb
            templateId={template.templateId}
            hasThumbnail={template.hasThumbnail}
            directUrl={template.thumbnailUrl}
          />
        </button>
      ) : (
        <TemplateThumb
          templateId={template.templateId}
          hasThumbnail={template.hasThumbnail}
          directUrl={template.thumbnailUrl}
        />
      )}
      {/* 发布状态胶囊（右上） */}
      <span
        className={`absolute right-1.5 top-1.5 rounded-full px-1.5 py-px text-[9px] font-medium text-white shadow-sm backdrop-blur-sm ${
          template.published ? "bg-emerald-500/90" : "bg-amber-500/90"
        }`}
      >
        {templateStatusCn(template)}
      </span>
      {/* 选中标识（左上）：未选中不渲染——点击缩略图即切换选中，
          选中反馈由描边高亮 + 实心勾承担，避免空心框叠在缩略图上像异常白块 */}
      {onToggle && checked === true ? (
        <span className="absolute left-1.5 top-1.5">
          <Checkbox checked onCheckedChange={() => onToggle()} />
        </span>
      ) : null}
      <div className="flex flex-1 flex-col gap-1 p-2">
        <span className="line-clamp-1 text-xs font-medium" title={template.name}>
          {template.name} <VisibilityBadge visibility={template.visibility} />
        </span>
        <OwnerLabel name={template.ownerName} />
        {footer}
      </div>
    </div>
  )
}

/** 小模板卡片常用底部操作（模板管理-小模板视图） */
export function TemplateManageFooter({
  template,
  regenerating,
  onEditBindings,
  onRegenerate,
}: {
  template: MockupExternalTemplateView
  regenerating?: boolean
  onEditBindings?: () => void
  onRegenerate?: () => void
}) {
  return (
    <>
      {!template.hasThumbnail && onRegenerate ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-full justify-start px-1 text-xs"
          disabled={regenerating}
          onClick={onRegenerate}
        >
          <RefreshCw className={`size-3 ${regenerating ? "animate-spin" : ""}`} />
          {regenerating ? "生成中…" : "生成缩略图"}
        </Button>
      ) : null}
      {onEditBindings ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-full justify-start px-1 text-xs"
          onClick={onEditBindings}
        >
          <Settings2 className="size-3" /> 编辑绑定
        </Button>
      ) : null}
    </>
  )
}
