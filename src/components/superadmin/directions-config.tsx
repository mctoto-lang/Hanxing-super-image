"use client"

import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DirectionFormDialog,
  DirectionEditButton,
  DirectionToggleActiveButton,
  type DirectionRow,
} from "@/components/superadmin/direction-form-dialog"
import { PRODUCT_MODE_LABELS } from "@/lib/product/dictionaries"

/** 二级分类定义（scope = product_direction.appliesTo 作用域，单选互斥） */
const CATEGORIES = [
  {
    scope: "suite" as const,
    label: PRODUCT_MODE_LABELS.suite,
    hint: "商品套图 tab 专属方向池（智能匹配与自定义配置共用）；与其他分类配置完全独立",
    dialog: {},
  },
  {
    scope: "detail" as const,
    label: PRODUCT_MODE_LABELS.detail,
    hint: "A+详情页 tab「可选择的方向」卡片池；与其他分类配置完全独立",
    dialog: {},
  },
  {
    scope: "refine" as const,
    label: PRODUCT_MODE_LABELS.refine,
    hint: "产品精修 tab 的快捷优化项卡片（上图标下文字）；每项对应一段精修提示词",
    dialog: {
      triggerLabel: "新增优化项",
      title: "新增优化项",
      description: "精修优化项供产品精修 tab 的快捷优化卡片选择",
    },
  },
]

/**
 * 图片方向配置（按二级分类：商品套图 / A+详情页 / 产品精修）
 *
 * 三个分类共用 product_direction 表但作用域单选互斥（每行恰属一个分类），
 * 配置彻底隔开：各分类新增/编辑互不影响。
 */
export function DirectionsConfig({ directions }: { directions: DirectionRow[] }) {
  return (
    <Tabs defaultValue="suite" className="gap-4">
      <TabsList>
        {CATEGORIES.map((c) => (
          <TabsTrigger key={c.scope} value={c.scope}>
            {c.label}
            <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px] tabular-nums">
              {directions.filter((d) => d.appliesTo.includes(c.scope)).length}
            </Badge>
          </TabsTrigger>
        ))}
      </TabsList>

      {CATEGORIES.map((c) => {
        const rows = directions.filter((d) => d.appliesTo.includes(c.scope))
        return (
          <TabsContent key={c.scope} value={c.scope} className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">{c.hint}</p>
              <DirectionFormDialog defaultScope={c.scope} {...c.dialog} />
            </div>

            <div className="rounded-lg border">
              <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>排序</TableHead>
                        <TableHead>标识</TableHead>
                        <TableHead>名称</TableHead>
                        <TableHead className="hidden md:table-cell">提示词模板</TableHead>
                        <TableHead>数量</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                            「{c.label}」分类暂无方向，请点击右上角新增（或运行 pnpm seed:product-v2）
                          </TableCell>
                        </TableRow>
                      ) : (
                        rows.map((d) => (
                          <TableRow key={d.id} className={d.isActive ? "" : "opacity-50"}>
                            <TableCell className="tabular-nums">{d.sortOrder}</TableCell>
                            <TableCell className="font-mono text-xs">{d.key}</TableCell>
                            <TableCell>
                              <div className="font-medium">{d.name}</div>
                              {d.description && (
                                <div className="text-xs text-muted-foreground">{d.description}</div>
                              )}
                            </TableCell>
                            <TableCell className="hidden max-w-[280px] truncate text-xs text-muted-foreground md:table-cell">
                              {d.promptTemplate}
                            </TableCell>
                        <TableCell className="text-xs">
                          {d.supportsCount ? `1-${d.maxCount} 张` : "1 张"}
                        </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge
                          variant={d.isActive ? "default" : "outline"}
                          className="text-[10px]"
                        >
                          {d.isActive ? "启用" : "停用"}
                        </Badge>
                        {d.isHidden && (
                          <Badge variant="secondary" className="text-[10px]">
                            前端隐藏
                          </Badge>
                        )}
                        {d.isHero && (
                          <Badge
                            variant="outline"
                            className="border-primary/40 text-[10px] text-primary"
                          >
                            主图类
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <DirectionEditButton row={d} />
                            <DirectionToggleActiveButton id={d.id} isActive={d.isActive} />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        )
      })}
    </Tabs>
  )
}
