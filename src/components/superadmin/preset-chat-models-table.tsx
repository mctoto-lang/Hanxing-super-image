"use client"

import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ChatModelEditButton,
  ChatModelToggleActiveButton,
} from "@/components/superadmin/chat-model-form-dialog"
import { DragHandle, useDragSort } from "@/hooks/use-drag-sort"
import {
  reorderPresetChatModelsAction,
  type PresetChatModelRow,
} from "@/server/actions/platform-chat-models"

const CHAT_FORMAT_LABEL: Record<string, string> = {
  openai: "OpenAI",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
}

/**
 * 平台预置对话模型列表（行首手柄拖拽排序）。
 *
 * 列表分页 20/页：拖拽仅作用于当前页子集，reorder 按值重分配
 * 保证跨页相对顺序不变。拖动顺序即用户端对话页模型列表顺序。
 */
export function PresetChatModelsTable({
  chatModels,
}: {
  chatModels: PresetChatModelRow[]
}) {
  const { ordered, rowProps, handleProps } = useDragSort({
    items: chatModels,
    commit: (ids) => reorderPresetChatModelsAction(ids),
  })

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" aria-label="拖动排序" />
          <TableHead>显示名</TableHead>
          <TableHead>接口</TableHead>
          <TableHead>上下文 / 输出</TableHead>
          <TableHead>价格（积分/百万tokens）</TableHead>
          <TableHead>参数</TableHead>
          <TableHead>并发 / 重试 / 超时</TableHead>
          <TableHead>状态</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((m) => (
          <TableRow key={m.id} {...rowProps(m.id)}>
            <TableCell className="w-8">
              <DragHandle handleProps={handleProps(m.id)} />
            </TableCell>
            <TableCell className="font-medium">{m.displayName}</TableCell>
            <TableCell className="text-sm">
              {CHAT_FORMAT_LABEL[m.formatType] ?? m.formatType}
              {m.supportsThinking ? (
                <Badge variant="outline" className="ml-1.5 text-[10px]">思考</Badge>
              ) : null}
              <div className="max-w-52 truncate text-xs text-muted-foreground">
                {m.apiEndpoint}
              </div>
            </TableCell>
            <TableCell className="text-sm tabular-nums text-muted-foreground">
              {m.maxContextTokens >= 1000
                ? `${Math.round(m.maxContextTokens / 1000)}K`
                : m.maxContextTokens}{" "}
              / {m.maxOutputTokens}
            </TableCell>
            <TableCell className="text-sm tabular-nums text-muted-foreground">
              {m.inputPriceCenticredits <= 0 && m.outputPriceCenticredits <= 0
                ? "免费"
                : `${(m.inputPriceCenticredits / 100).toFixed(2)} / ${(m.outputPriceCenticredits / 100).toFixed(2)}`}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {m.extraConfig?.temperature !== undefined
                ? `T=${m.extraConfig.temperature}`
                : "T=默认"}
              {m.extraConfig?.maxTokens
                ? ` · ${m.extraConfig.maxTokens} tokens`
                : ""}
            </TableCell>
            <TableCell className="text-sm tabular-nums text-muted-foreground">
              {m.maxConcurrent} / {m.maxRetries} / {m.apiTimeout}s
            </TableCell>
            <TableCell>
              {m.isActive ? (
                <Badge>启用</Badge>
              ) : (
                <Badge variant="outline">停用</Badge>
              )}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <ChatModelEditButton model={m} />
                <ChatModelToggleActiveButton model={m} />
              </div>
            </TableCell>
          </TableRow>
        ))}
        {ordered.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="text-center text-muted-foreground">
              暂无平台预置对话模型，点击右上角新建
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  )
}
