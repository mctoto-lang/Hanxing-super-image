"use client"

import * as React from "react"
import { ListRestart } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DashRing } from "@/components/ui/dash-ring"
import { fetchUpstreamModelsAction } from "@/server/actions/model-upstream"

/**
 * 模型表单「拉取上游模型列表」按钮（生图/对话、企业/平台四侧共用）。
 *
 * 对接 OpenAI 兼容网关（new-api / sub2api 等）时一键拉取上游模型清单，
 * 下拉选择后回填「模型标识」，免手抄模型名。生图表单在 openai/chat 格式
 * 走 /v1/models、gemini 官方原生走 /v1beta/models；对话表单在
 * openai/grok 格式下显示（其余私有协议无列表端点，不提供）。
 */
export function UpstreamModelFetch({
  scope,
  kind,
  endpoint,
  apiKey,
  modelId,
  apiFormat,
  onPick,
}: {
  scope: "enterprise" | "platform"
  kind: "image" | "chat"
  /** 表单当前 API 地址（响应式传入，随输入更新） */
  endpoint: string
  /** 表单当前 API Key（编辑态留空时服务端用已存密钥兜底） */
  apiKey: string
  /** 编辑态模型 ID（留空 Key 时用已存密钥拉取） */
  modelId?: string
  /** 生图模型接口格式（gemini→v1beta/models；缺省 /v1/models） */
  apiFormat?: "openai" | "chat" | "gemini" | "midjourney" | "jimeng" | "grsai"
  /** 选中模型后回填（通常写入表单 name 字段） */
  onPick: (model: string) => void
}) {
  const [pending, setPending] = React.useState(false)
  const [modelIds, setModelIds] = React.useState<string[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function handleFetch() {
    setPending(true)
    setError(null)
    try {
      const res = await fetchUpstreamModelsAction({
        scope,
        kind,
        endpoint,
        apiKey,
        modelId,
        ...(kind === "image" && apiFormat ? { apiFormat } : {}),
      })
      if (res.ok) {
        setModelIds(res.models)
      } else {
        setModelIds(null)
        setError(res.error)
      }
    } catch {
      setModelIds(null)
      setError("拉取模型列表失败")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7"
        onClick={handleFetch}
        disabled={pending || !endpoint.trim()}
      >
        {pending ? (
          <DashRing className="size-3.5" />
        ) : (
          <ListRestart className="size-3.5" />
        )}
        {pending ? "拉取中…" : "拉取上游模型列表"}
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {modelIds && !error ? (
        <Select
          value="__pick"
          onValueChange={(v) => {
            if (typeof v === "string" && v !== "__pick") onPick(v)
          }}
        >
          <SelectTrigger className="h-8 w-full">
            <SelectValue>{`已拉取 ${modelIds.length} 个模型，选择填入`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {modelIds.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  )
}
