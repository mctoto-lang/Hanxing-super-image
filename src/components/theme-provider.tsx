"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"

/**
 * 主题 Provider（手册 §7.3）
 *
 * 默认锁定黑夜模式（dark），不允许跟随系统（enableSystem=false），
 * 用户可在侧边栏 nav-user 内手动切换，但首次进入强制 dark。
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}
