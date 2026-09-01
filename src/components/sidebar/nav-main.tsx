"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import type { NavItem } from "./types"
import { NavIcon } from "./icons"

export function NavMain({ items }: { items: NavItem[] }) {
  const pathname = usePathname()
  return (
    <SidebarGroup>
      <SidebarGroupLabel>工作台</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const active =
            item.isActive ??
            (pathname === item.url || pathname.startsWith(item.url + "/"))
          return (
            <CollapsibleItem
              key={item.title}
              item={item}
              active={active}
            />
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}

function CollapsibleItem({
  item,
  active,
}: {
  item: NavItem
  active: boolean
}) {
  const pathname = usePathname()
  const hasSub = (item.items?.length ?? 0) > 0
  // 父组展开条件：自身命中 或 任一子项命中（在子页面时保持展开）
  const subActive =
    item.items?.some(
      (sub) => pathname === sub.url || pathname.startsWith(sub.url + "/"),
    ) ?? false
  const [open, setOpen] = React.useState(active || subActive)

  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<SidebarMenuItem />}>
      {hasSub ? (
        // 有子项：父按钮整体作为折叠触发器（点击文字或图标均展开/折叠）
        <CollapsibleTrigger
          render={<SidebarMenuButton tooltip={item.title} isActive={active} />}
        >
          <NavIcon name={item.icon} />
          <span>{item.title}</span>
          <ChevronRight
            className={cn(
              "ml-auto transition-transform duration-200 ease-in-out",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
      ) : (
        // 无子项：直接导航
        <SidebarMenuButton
          tooltip={item.title}
          isActive={active}
          render={<Link href={item.url} />}
        >
          <NavIcon name={item.icon} />
          <span>{item.title}</span>
        </SidebarMenuButton>
      )}

      {hasSub ? (
        <CollapsibleContent>
          <SidebarMenuSub>
            {item.items!.map((subItem) => {
              const subItemActive =
                pathname === subItem.url ||
                pathname.startsWith(subItem.url + "/")
              return (
                <SidebarMenuSubItem key={subItem.title}>
                  <SidebarMenuSubButton
                    isActive={subItemActive}
                    render={<Link href={subItem.url} />}
                  >
                    <span>{subItem.title}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  )
}
