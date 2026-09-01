"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"

/**
 * 主题 Provider（手册 §7.3）
 *
 * 默认锁定黑夜模式（dark），不允许跟随系统（enableSystem=false），
 * 用户可在侧边栏底部「月之亮面/月之暗面」开关手动切换，首次进入为 dark。
 * 注意：不启用 disableTransitionOnChange——它会在切换瞬间禁用所有
 * transition，导致开关的太阳/月亮图标动画失效。
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
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}
