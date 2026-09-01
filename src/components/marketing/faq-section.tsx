"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

/**
 * 帮助中心 FAQ 区块（marketing 落地页「帮助中心」锚点）
 *
 * 改写自 shadcn 风格 FAQ 手风琴模板：原版依赖 framer-motion（分类标签的
 * 渐变滑块、列表切换的 AnimatePresence、手风琴高度补间），这里全部换成
 * 纯 CSS——标签滑块用 scale-y transform 过渡，列表切换靠 key 重挂载复用
 * globals.css 的 fadeSlideIn（旧内容直接卸载、无退出动画），手风琴高度用
 * Base UI Collapsible Panel 自带的 --collapsible-panel-height 变量做
 * height 过渡。配色不用 shadcn token，直接对齐落地页的深色白系
 * （bg-neutral-950 + white/xx），避免营销页未挂 .dark 时 token 失真。
 */

interface FaqEntry {
  question: string
  answer: string
}

/** 分类 key → 展示名（顺序即标签排列顺序） */
const FAQ_CATEGORIES = {
  account: "账号与登录",
  credits: "积分与计费",
  generation: "图片生成",
  mockup: "样机与模板",
} as const

type FaqCategory = keyof typeof FAQ_CATEGORIES

/** 占位内容：先按业务能力拟稿，文案后续按反馈修改 */
const FAQ_DATA: Record<FaqCategory, FaqEntry[]> = {
  account: [
    {
      question: "如何注册使用瀚星 Super Image？",
      answer:
        "平台面向企业用户提供服务，开通企业空间后，由企业管理员通过邮箱邀请成员加入，使用邮箱验证码即可登录，无需安装客户端。",
    },
    {
      question: "企业内的成员角色有什么区别？",
      answer:
        "企业所有者可管理成员、套餐与积分；管理员可协助管理成员与查看操作日志；普通成员可使用图片生成、样机渲染等全部创作功能。",
    },
    {
      question: "忘记密码或无法登录怎么办？",
      answer:
        "登录页支持通过注册邮箱接收验证码完成登录与重置；若邮箱无法收信，可联系企业管理员处理或咨询平台客服。",
    },
    {
      question: "可以在多台设备上同时使用吗？",
      answer:
        "可以。账号支持多设备登录，创作记录与资产自动云端同步，换设备也能接着工作。",
    },
  ],
  credits: [
    {
      question: "积分是什么，如何消耗？",
      answer:
        "积分是平台的统一计费单位，图像生成与样机渲染按次消耗积分，不同模型与分辨率的消耗标准不同，任务创建时页面会显示预计消耗。",
    },
    {
      question: "月付与年付有什么区别？",
      answer:
        "功能完全一致。年付按月付价格 88 折计算，适合长期使用的团队；两种方式均可随时升级或更换套餐。",
    },
    {
      question: "当月用不完的积分会清零吗？",
      answer:
        "套餐积分按月自动发放，未使用完的部分可结转使用（具体规则以套餐说明为准），单独充值的积分不受月度周期限制。",
    },
    {
      question: "如何升级套餐或追加积分？",
      answer:
        "企业管理员可在管理后台为企业升级套餐或充值积分，变更即时生效，成员无需重新登录。",
    },
  ],
  generation: [
    {
      question: "平台支持哪些图像生成模型？",
      answer:
        "内置 GPT、Gemini 等前沿图像生成模型，企业可按需在管理后台开启可用模型，模型持续更新，无需额外付费。",
    },
    {
      question: "生成的图片可以商用吗？",
      answer:
        "可以。通过套餐生成的图片成果归企业所有，可用于电商、广告等商业场景，具体权利义务以服务协议为准。",
    },
    {
      question: "支持批量生成吗？",
      answer:
        "支持。工作台提供批量生图模式，可一次提交多组提示词任务，系统排队依次生成，完成后统一存入资产管理。",
    },
    {
      question: "生成失败或效果不满意怎么办？",
      answer:
        "生成失败的任务不扣除积分，积分会自动退回；对效果不满意可在原任务基础上调整提示词重新生成。",
    },
    {
      question: "上传的素材与生成结果存在哪里？",
      answer:
        "全部资产自动存入「资产管理」，支持按任务检索、下载与删除；不同企业的资产相互隔离，互不可见。",
    },
  ],
  mockup: [
    {
      question: "PS 样机渲染是如何工作的？",
      answer:
        "上传 PSD 样机源文件并指定要替换的图层，AI 生成的图片会自动贴合图层的透视与光影，一键输出成品样机图。",
    },
    {
      question: "提示词模板有什么用？",
      answer:
        "模板库沉淀了商品图片、场景图等常用提示词组合，团队成员可直接套用并微调，保证出图风格统一、降低上手门槛。",
    },
    {
      question: "样机渲染支持哪些文件格式？",
      answer:
        "目前支持 PSD 格式源文件，建议使用图层结构清晰、智能对象规范的样机文件，以获得最佳替换效果。",
    },
    {
      question: "企业可以自定义模板吗？",
      answer:
        "可以。企业管理员可将团队常用的提示词保存为企业模板，供全体成员直接调用。",
    },
  ],
}

interface FaqSectionProps {
  heading: string
  subtitle?: string
  description?: string
  className?: string
}

export default function FaqSection({
  heading,
  subtitle,
  description,
  className,
}: FaqSectionProps) {
  const [selected, setSelected] = useState<FaqCategory>("account")

  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center",
        className,
      )}
    >
      <FaqHeader heading={heading} subtitle={subtitle} description={description} />
      <FaqTabs selected={selected} onSelect={setSelected} />
      <div className="mx-auto mt-12 w-full max-w-3xl">
        {/* key 重挂载让 fadeSlideIn 在切换分类时重放 */}
        <div key={selected} className="animate-fade-slide-in-1 space-y-4">
          {FAQ_DATA[selected].map((faq) => (
            <FaqItem key={faq.question} {...faq} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** 标题区：渐变小字 + 大标题，背后模糊光晕向上溢出（由外层 section 裁剪） */
function FaqHeader({
  heading,
  subtitle,
  description,
}: Pick<FaqSectionProps, "heading" | "subtitle" | "description">) {
  return (
    <div className="relative flex flex-col items-center justify-center">
      <span
        aria-hidden
        className="absolute -top-[350px] left-1/2 h-[500px] w-[min(600px,90vw)] -translate-x-1/2 rounded-full bg-gradient-to-r from-white/[0.06] to-white/[0.03] blur-3xl"
      />
      {subtitle && (
        <span className="relative z-10 mb-3 bg-gradient-to-r from-white/80 to-white/40 bg-clip-text font-medium text-transparent">
          {subtitle}
        </span>
      )}
      <h2 className="relative z-10 text-center text-3xl font-bold tracking-tight text-white sm:text-4xl">
        {heading}
      </h2>
      {description && (
        <p className="relative z-10 mt-4 max-w-xl text-center text-sm text-white/60 sm:text-base">
          {description}
        </p>
      )}
    </div>
  )
}

/** 分类标签：选中项白色填充块自底部滑入（scale-y 替代 framer-motion 位移补间） */
function FaqTabs({
  selected,
  onSelect,
}: {
  selected: FaqCategory
  onSelect: (category: FaqCategory) => void
}) {
  return (
    <div className="relative z-10 mt-10 flex flex-wrap items-center justify-center gap-2.5">
      {(Object.keys(FAQ_CATEGORIES) as FaqCategory[]).map((category) => {
        const active = selected === category
        return (
          <button
            key={category}
            type="button"
            onClick={() => onSelect(category)}
            aria-pressed={active}
            className={cn(
              "relative cursor-pointer overflow-hidden whitespace-nowrap rounded-full border px-4 py-1.5 text-sm font-medium transition-colors duration-300",
              active
                ? "border-transparent text-neutral-900"
                : "border-white/15 bg-transparent text-white/60 hover:text-white",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "absolute inset-0 origin-bottom rounded-[inherit] bg-white transition-transform duration-300 ease-out",
                active ? "scale-y-100" : "scale-y-0",
              )}
            />
            <span className="relative z-10">{FAQ_CATEGORIES[category]}</span>
          </button>
        )
      })}
    </div>
  )
}

/** 单条问答卡片：Base UI Collapsible + CSS 高度过渡（--collapsible-panel-height 由 Panel 自动测量） */
function FaqItem({ question, answer }: FaqEntry) {
  const [open, setOpen] = useState(false)

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "rounded-xl border transition-colors duration-300",
        open
          ? "border-white/15 bg-white/[0.05]"
          : "border-white/10 bg-white/[0.02]",
      )}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-4 p-4 text-left">
        <span
          className={cn(
            "text-base font-medium transition-colors duration-300",
            open ? "text-white" : "text-white/70",
          )}
        >
          {question}
        </span>
        <Plus
          className={cn(
            "h-5 w-5 shrink-0 transition-all duration-200",
            open ? "rotate-45 text-white" : "text-white/50",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-0 overflow-hidden transition-[height] duration-300 ease-in-out motion-reduce:transition-none data-[open]:h-[var(--collapsible-panel-height)] data-[starting-style]:h-0">
        <p className="px-4 pb-4 text-sm leading-relaxed text-white/60">
          {answer}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}
