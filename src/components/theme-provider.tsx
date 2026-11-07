"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"

/**
 * 主题 Provider（手册 §7.3）
 *
 * 支持浅色/深色/跟随系统三态，在侧边栏用户菜单单项循环切换
 * （next-themes 默认 localStorage 键 "theme" 持久化，纯客户端不落库）。
 * 默认跟随系统（system）——首次访问（无存储值）自动跟随浏览器
 * prefers-color-scheme，存量明/暗偏好不受影响。
 * 注意：不启用 disableTransitionOnChange——它会在切换瞬间禁用所有
 * transition，导致主题切换时的图标/过渡动画失效。
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}
