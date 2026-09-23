"use client"

import * as React from "react"
import { PanelLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

/**
 * 双栏工作区响应式布局（/create、/chat 共用，P1-3）
 *
 * ≥md：左栏固定 280px + 右侧内容区（原布局不变）；
 * <md：左栏收进左抽屉，内容区顶部出现细栏（唤出按钮 + 当前标题），
 * 主内容全宽（对标 ChatGPT 移动版）。
 */
export function WorkspaceSplit({
  sidebar,
  mobileTitle,
  children,
}: {
  /** 左栏内容（桌面侧栏与移动抽屉复用同一节点） */
  sidebar: React.ReactNode
  /** 移动端顶栏标题（通常为当前会话名/「新对话」） */
  mobileTitle: string
  /** 右侧主内容 */
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <div className="flex h-full flex-col overflow-hidden md:flex-row">
      {/* 桌面左栏 */}
      <aside className="hidden w-[280px] shrink-0 border-r bg-sidebar/30 md:block">
        {sidebar}
      </aside>

      {/* 右侧内容区：移动端（<md）顶部多一条抽屉唤出栏 */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-11 shrink-0 items-center gap-1.5 border-b px-2 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="打开列表"
                />
              }
            >
              <PanelLeft className="size-4" />
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-[280px] gap-0 p-0 sm:max-w-[280px]"
            >
              <SheetHeader className="sr-only">
                <SheetTitle>{mobileTitle}</SheetTitle>
              </SheetHeader>
              {sidebar}
            </SheetContent>
          </Sheet>
          <span className="min-w-0 truncate text-sm font-medium">
            {mobileTitle}
          </span>
        </div>
        {children}
      </main>
    </div>
  )
}
