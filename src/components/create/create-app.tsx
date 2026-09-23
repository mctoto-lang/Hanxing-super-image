"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ConversationList } from "@/components/create/conversation-list"
import { ConversationDetail } from "@/components/create/conversation-detail"
import { CreatePromptInput } from "@/components/create/create-prompt-input"
import { WorkspaceSplit } from "@/components/shared/workspace-split"
import { Sparkles } from "lucide-react"
import { type ConversationListItem } from "@/components/create/conversation-list"
import { type TaskDetail } from "@/components/create/task-detail-card"
import type { CreateModel } from "@/components/create/types"

/** 空态示例提示词：点击一键填入输入框（对标主流 AI 工具的空态行动化引导） */
const EXAMPLE_PROMPTS = [
  "白底电商主图：磨砂质感保温杯，45° 摆放，柔和影棚光",
  "产品场景图：香薰蜡烛放在原木桌面，暖光氛围，浅景深",
  "一只戴墨镜的柯基在沙滩奔跑，3D 皮克斯风格",
  "极简婴儿连体衣平铺拍摄，浅粉色背景，俯视角",
  "赛博朋克城市夜景，霓虹灯反射在湿漉漉的街道上",
]

/**
 * 自由创作页根组件（client，自由创作页 §6 v2）
 *
 * 布局：WorkspaceSplit（≥md 固定 280px 左栏 + 右侧内容区；
 * <md 左栏收进抽屉，ChatGPT 移动版模式），无可拖动分割线。
 *
 * - 选中态由 URL search param `c` 驱动。
 * - 新对话模式（c 缺省）：右侧垂直居中显示 PromptInput。
 * - 会话模式（c 有效）：右侧显示历史详情 + 底部固定 PromptInput。
 */
export function CreateApp({
  models,
  conversations,
  conversationTasks,
  userCredits,
  enterpriseCredits,
}: {
  models: CreateModel[]
  conversations: ConversationListItem[]
  conversationTasks: TaskDetail[]
  userCredits: number
  enterpriseCredits: number
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const c = searchParams.get("c")
  const selectedConv = conversations.find((x) => x.id === c) ?? null

  // 空态示例提示词一键填入（经 CreatePromptInput 的 prefill 通道）
  const [prefill, setPrefill] = React.useState<{
    text: string
    nonce: number
  } | null>(null)

  function navigateTo(id: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (id) {
      params.set("c", id)
    } else {
      params.delete("c")
    }
    const qs = params.toString()
    router.push(qs ? `/create?${qs}` : "/create")
  }

  return (
    <WorkspaceSplit
      sidebar={
        <ConversationList
          conversations={conversations}
          selectedId={selectedConv?.id ?? null}
          onSelect={navigateTo}
        />
      }
      mobileTitle={selectedConv?.title ?? "开始你的创作"}
    >
      {/* 内容区（占满剩余；仅内部任务列表可滚，整页不滚动） */}
      {selectedConv ? (
        <ConversationDetail
          conversationId={selectedConv.id}
          tasks={conversationTasks}
          models={models}
          userCredits={userCredits}
          enterpriseCredits={enterpriseCredits}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center overflow-auto p-6">
          <div className="w-full max-w-2xl space-y-6">
            <div className="text-center">
              <div className="mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-primary/10">
                <Sparkles className="size-6 text-primary" />
              </div>
              <h1 className="text-xl font-semibold">开始你的创作</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                输入提示词，生成你想要的图片
              </p>
            </div>
            {/* 示例提示词：点击直接填入并聚焦输入框 */}
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLE_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPrefill({ text: p, nonce: Date.now() })}
                  className="max-w-full truncate rounded-full border bg-card/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                >
                  {p}
                </button>
              ))}
            </div>
            {/* 生图输入框 */}
            <CreatePromptInput
              models={models}
              userCredits={userCredits}
              enterpriseCredits={enterpriseCredits}
              onConversationCreated={(id) => navigateTo(id)}
              prefill={prefill}
              onPrefillApplied={() => setPrefill(null)}
              focusNonce={prefill?.nonce}
            />
          </div>
        </div>
      )}
    </WorkspaceSplit>
  )
}
