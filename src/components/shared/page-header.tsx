import type * as React from "react"

/**
 * 管理页头部（超管侧统一形态）
 *
 * 左侧标题 + 描述，右侧操作区（筛选 / 新建按钮等）。
 * 替换 platform 各页手写标题区（此前 models / chat-models 漏 gap-4、
 * 二级配置页无标题等不一）。页面容器统一 space-y-4。
 */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  /** 右侧操作区 */
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </div>
  )
}
