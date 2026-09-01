"use client"

import * as React from "react"

/**
 * BorderBeam 动态加载包装器（自由创作页 §6）
 *
 * border-beam npm 包依赖浏览器 DOM API 自动检测元素尺寸并动态注入 CSS，
 * 在 SSR 阶段无 DOM 时与服务端渲染不一致，导致 React hydration mismatch。
 *
 * 解决：仅在客户端挂载后才渲染真实 BorderBeam，挂载前渲染普通 div 包裹
 * children，保持布局稳定。
 */
type BorderBeamProps = React.ComponentProps<"div"> & {
  active?: boolean
  size?: "sm" | "md" | "line" | "pulse-outside" | "pulse-inner"
  colorVariant?: "colorful" | "mono" | "ocean" | "sunset"
  theme?: "dark" | "light" | "auto"
  duration?: number
  strength?: number
  borderRadius?: number
  children?: React.ReactNode
}

// 懒加载真实组件
const BorderBeamClient = React.lazy(() =>
  import("border-beam").then((m) => ({
    default: m.BorderBeam as React.ComponentType<BorderBeamProps>,
  })),
)

export function BeamWrapper(props: BorderBeamProps) {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => {
    setMounted(true)
  }, [])

  // 服务端/首次渲染：渲染普通 div 包裹 children，避免 hydration mismatch
  if (!mounted) {
    return <div style={{ borderRadius: props.borderRadius }}>{props.children}</div>
  }

  return (
    <React.Suspense fallback={<div style={{ borderRadius: props.borderRadius }}>{props.children}</div>}>
      <BorderBeamClient {...props} />
    </React.Suspense>
  )
}
