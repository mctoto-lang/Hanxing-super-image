import Link from "next/link"
import { CompassIcon, HouseIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"

export function NotFound() {
  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden">
      <Empty>
        <EmptyHeader>
          <EmptyTitle className="mask-b-from-20% mask-b-to-80% font-extrabold text-9xl">
            404
          </EmptyTitle>
          <EmptyDescription className="-mt-8 text-foreground/80">
            您访问的页面可能已被移动或不存在
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex gap-2">
            <Button render={<Link href="/" />}>
              <HouseIcon className="size-4" data-icon="inline-start" />
              返回首页
            </Button>
            <Button variant="outline" render={<Link href="/create" />}>
              <CompassIcon className="size-4" data-icon="inline-start" />
              前往工作台
            </Button>
          </div>
        </EmptyContent>
      </Empty>
    </div>
  )
}
