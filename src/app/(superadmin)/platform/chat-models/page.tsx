import { requireSuperAdmin } from "@/lib/auth/session"
import { listPresetChatModelsAction } from "@/server/actions/platform-chat-models"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
  TablePagination,
  parsePageParam,
} from "@/components/shared/table-pagination"
import {
  ChatModelFormDialog,
  ChatModelEditButton,
  ChatModelToggleActiveButton,
} from "@/components/superadmin/chat-model-form-dialog"

export const dynamic = "force-dynamic"

/**
 * 平台预置对话模型（OpenAI 兼容 LLM）
 *
 * 供提示词模板关联使用（裂变/细化/重生成/提取/翻译）；
 * 全部启用中的平台预置对话模型对所有企业可见。
 */
const CHAT_FORMAT_LABEL: Record<string, string> = {
  openai: "OpenAI",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
}

export default async function PlatformChatModelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireSuperAdmin()
  const page = parsePageParam(await searchParams)
  const { items: chatModels, total, activeCount, pageSize } =
    await listPresetChatModelsAction({ page, pageSize: 20 })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">平台预置对话模型</h1>
          <p className="text-sm text-muted-foreground">
            超管管理全企业共享的对话模型（OpenAI 兼容格式，enterpriseId
            为空）；用于提示词模板的裂变/细化/重生成/提取/翻译；API Key 加密落库
          </p>
        </div>
        <ChatModelFormDialog />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              预置对话模型总数
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {total}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              启用中
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold tabular-nums">
            {activeCount}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">预置对话模型列表</CardTitle>
          <CardDescription>
            启用中的平台预置对话模型对所有企业可见；企业也可在「企业管理 →
            对话模型」中自建私有对话模型
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
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
              {chatModels.map((m) => (
                <TableRow key={m.id}>
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
              {chatModels.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    暂无平台预置对话模型，点击右上角新建
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/platform/chat-models"
        />
      </Card>
    </div>
  )
}
