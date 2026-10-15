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
 *
 * 性能（pnpm patch 补丁配合）：border-beam 默认每实例 useId 生成唯一 id 并
 * 注入一份巨型 <style>，批量生图多卡同挂载时 CSSOM 成倍膨胀。补丁新增
 * beamId prop——同参数实例共享同一 id，配合包内按 id+内容哈希的全局去重
 * 注入，相同配置只落一份样式表。
 */
type BorderBeamProps = React.ComponentProps<"div"> & {
  active?: boolean
  size?: "sm" | "md" | "line" | "pulse-outside" | "pulse-inner"
  colorVariant?: "colorful" | "mono" | "ocean" | "sunset"
  theme?: "dark" | "light" | "auto"
  duration?: number
  strength?: number
  borderRadius?: number
  /** 共享样式 id（补丁版 prop）：同参数实例复用同一份注入 CSS */
  beamId?: string
  children?: React.ReactNode
}

/** 影响生成 CSS 的参数组合 → 稳定共享 id（FNV-1a 短哈希，字母数字可安全作 data-beam 属性值） */
function computeBeamId(props: BorderBeamProps): string {
  const key = [
    props.size ?? "md",
    props.colorVariant ?? "colorful",
    props.theme ?? "auto",
    props.borderRadius ?? "",
    props.duration ?? "",
    props.strength ?? "",
  ].join("|")
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return "beam" + (hash >>> 0).toString(36)
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
      <BorderBeamClient {...props} beamId={props.beamId ?? computeBeamId(props)} />
    </React.Suspense>
  )
}
