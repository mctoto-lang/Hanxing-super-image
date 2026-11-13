"use client"

/**
 * 更新日志页（/changelog，公开）
 * 移植 21st.dev 模板 interactive-changelog-with-dialog：
 * - shader 头图（MeshGradient + Dithering，@paper-design/shaders-react）+ 时间线式日志列表 + Dialog 详情
 * - 本地适配：模板 radix Dialog/Tooltip 换项目 base-ui 版（Trigger 用 render 组合）；
 *   营销页深色口径硬编码 neutral-950（不挂 .dark，不用 shadcn token）；
 *   贡献者头像固定为 Claude / OpenAI / GLM 三枚模型图标（@lobehub/icons）；
 *   Copy 按钮真复制 /changelog#{id} + toast；每条带锚点直达。
 */

import { Copy, ExternalLink, GitPullRequest, Maximize2 } from "lucide-react"
import { Dithering, MeshGradient } from "@paper-design/shaders-react"
import { Claude, OpenAI, Zhipu } from "@lobehub/icons"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** 模板配图（抽象渐变图，与内容无强关联，两条交替使用） */
const IMAGES = [
  "https://cdn.21st.dev/assets/mirror/30/30bcfaba9176f56d995521125bb0cc7ed48375340615627d6f118504faeaa7db.png",
  "https://cdn.21st.dev/assets/mirror/0d/0d7ab6e96249f6d408178fa3c8ab54959252b472eea3fd2792a9eeb7d16fbada.png",
]

interface ReleaseItem {
  id: string
  title: string
  date: string
  excerpt: string
  image: string
  /** 条目旁的哲理名言（每条不同） */
  quote: string
  /** Dialog 内详情（prose 排版） */
  content: React.ReactNode
}

/** 模型接入公告（日期为各模型官方发布日，倒序展示） */
const RELEASES: ReleaseItem[] = [
  {
    id: "gpt-image-2-6",
    title: "GPT-Image 2.6 已接入",
    date: "2026-11-04",
    excerpt: "OpenAI 最新旗舰生图模型 GPT-Image 2.6 正式接入，生成速度较上代提升约 50%。",
    image: IMAGES[0],
    quote: "「简约是终极的精致。」—— 列奥纳多·达·芬奇",
    content: (
      <div className="prose prose-invert prose-neutral">
        <h3>已接入并支持 GPT-Image 2.6</h3>
        <ul>
          <li>已接入并全功能支持（自由创作 / 模板 / Agent 生图）</li>
          <li>文字渲染与指令遵循显著增强</li>
          <li>速度提升约 50%，出图更快</li>
        </ul>
      </div>
    ),
  },
  {
    id: "nano-banana-2-1",
    title: "Nano banana 2.1 已接入",
    date: "2026-10-06",
    excerpt: "Google Nano banana 2.1（Gemini 3 系列 Flash Image）正式接入。",
    image: IMAGES[1],
    quote: "「生活中不是缺少美，而是缺少发现美的眼睛。」—— 奥古斯特·罗丹",
    content: (
      <div className="prose prose-invert prose-neutral">
        <h3>已接入并支持 Nano banana 2.1</h3>
        <ul>
          <li>已接入并全功能支持</li>
          <li>图像质量与一致性升级，价格更低</li>
          <li>适合大批量商品图生产</li>
        </ul>
      </div>
    ),
  },
  {
    id: "gpt-image-2-5",
    title: "GPT-Image 2.5 已接入",
    date: "2026-09-08",
    excerpt: "GPT-Image 2.5 正式接入，复杂构图与多元素场景更稳。",
    image: IMAGES[0],
    quote: "「想象力比知识更重要。」—— 阿尔伯特·爱因斯坦",
    content: (
      <div className="prose prose-invert prose-neutral">
        <h3>已接入并支持 GPT-Image 2.5</h3>
        <ul>
          <li>已接入并全功能支持</li>
          <li>多元素场景构图能力增强</li>
          <li>支持精细参考图控制</li>
        </ul>
      </div>
    ),
  },
  {
    id: "gpt-image-2",
    title: "GPT-Image 2 已接入",
    date: "2026-04-21",
    excerpt: "GPT-Image 2 系列首发接入，新一代生图基座全面可用。",
    image: IMAGES[1],
    quote: "「每个孩子都是艺术家，问题的关键是如何在长大后依然保有这份天赋。」—— 巴勃罗·毕加索",
    content: (
      <div className="prose prose-invert prose-neutral">
        <h3>已接入并支持 GPT-Image 2</h3>
        <ul>
          <li>已接入并全功能支持</li>
          <li>原生高分辨率输出</li>
          <li>智能文案与图像合成一体化</li>
        </ul>
      </div>
    ),
  },
]

/** 贡献者：固定三枚模型图标部分堆叠（模板 -space-x-2 样式）+ 该条目专属哲理名言 */
function ModelContributors({ quote }: { quote: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2" aria-label="由 Claude、OpenAI、GLM 协同构建">
      <div className="flex items-center -space-x-2">
        {[
          { label: "Claude", node: <Claude.Color size={13} /> },
          { label: "OpenAI", node: <OpenAI size={13} color="#FFFFFF" /> },
          { label: "GLM", node: <Zhipu.Color size={13} /> },
        ].map(({ label, node }) => (
          <span
            key={label}
            aria-hidden
            title={label}
            className="flex size-6 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800"
          >
            {node}
          </span>
        ))}
      </div>
      <span className="truncate text-sm text-white/60">{quote}</span>
    </div>
  )
}

async function copyReleaseLink(id: string) {
  const url = `${window.location.origin}/changelog#${id}`
  try {
    await navigator.clipboard.writeText(url)
    toast.success("链接已复制")
  } catch {
    toast.error("复制失败，请手动复制地址栏链接")
  }
}

export default function ChangelogPage() {
  return (
    <section className="relative w-full overflow-hidden bg-neutral-950 font-sans text-white">
      {/* shader 头图：全宽动效 + 标题 */}
      <div className="relative w-full overflow-hidden">
        <MeshGradient
          colors={["#5b00ff", "#00ffa3", "#ff9a00", "#ea00ff"]}
          swirl={0.55}
          distortion={0.85}
          speed={0.1}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
        {/* Dithering 用库默认参数动态渲染（speed=1 噪点流动）。注意：模板旧 API 的 colors/intensity
            在 0.0.82 已不存在；曾尝试 colorBack/colorFront 近白两色 + 低透明度等效，但对比度太弱
            动画感尽失（观感成静态图），故回归默认参数的动态噪点效果（用户定稿口径） */}
        <Dithering
          shape="simplex"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/20 to-black/30" />

        <div className="relative container mx-auto px-4 py-12 text-left">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-white/80">
              <GitPullRequest className="size-4" />
              <p>更新日志</p>
            </div>
            <h1 className="text-4xl leading-snug font-semibold text-white">
              最新增强
              <br /> 与平台动态
            </h1>
          </div>
        </div>
      </div>

      {/* 时间线 */}
      <div className="container mx-auto justify-center border-x border-neutral-800 px-4">
        {RELEASES.map((item) => (
          <Dialog key={item.id}>
            <div id={item.id} className="relative flex w-full scroll-mt-24 flex-col gap-6 py-16 lg:flex-row lg:gap-0">
              <div className="h-fit lg:sticky lg:top-2">
                <time className="w-36 text-sm font-medium text-white/50 lg:absolute">
                  {item.date}
                </time>
              </div>

              <div className="flex max-w-prose flex-col gap-4 lg:mx-auto">
                <h3 className="text-3xl font-medium lg:pt-10">{item.title}</h3>

                {/* 点击配图打开详情 */}
                <DialogTrigger
                  className="relative block w-full cursor-pointer"
                  aria-label={`查看「${item.title}」详情`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- 模板外域配图，沿用 Bento 批次口径 */}
                  <img
                    src={item.image}
                    alt={item.title}
                    className="aspect-video max-h-96 w-full rounded-lg border border-neutral-800 object-cover"
                  />
                  <div className="pointer-events-none absolute inset-0 rounded-lg bg-gradient-to-b from-transparent to-black/50" />
                </DialogTrigger>

                <p className="text-sm font-medium text-white/60">{item.excerpt}</p>

                <div className="flex items-center justify-between gap-4">
                  <ModelContributors quote={item.quote} />

                  <div className="flex items-center gap-1">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <DialogTrigger
                              render={
                                <Button variant="ghost" size="icon" aria-label="查看完整发布">
                                  <Maximize2 className="size-4" />
                                </Button>
                              }
                            />
                          }
                        />
                        <TooltipContent>
                          <p>查看完整发布</p>
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="复制链接"
                              onClick={() => copyReleaseLink(item.id)}
                            >
                              <Copy className="size-4" />
                            </Button>
                          }
                        />
                        <TooltipContent>
                          <p>复制链接</p>
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="新标签打开"
                              onClick={() => window.open(`/changelog#${item.id}`, "_blank")}
                            >
                              <ExternalLink className="size-4" />
                            </Button>
                          }
                        />
                        <TooltipContent>
                          <p>新标签打开</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </div>
              </div>

              <div className="absolute bottom-0 left-0 right-0 h-px w-[200vw] -translate-x-1/2 bg-neutral-800" />
            </div>

            <DialogContent className="max-h-[90vh] gap-4 overflow-y-auto border-neutral-800 bg-neutral-900 text-white sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle className="text-left text-white">{item.title}</DialogTitle>
                <DialogDescription className="text-left text-white/60">{item.excerpt}</DialogDescription>
              </DialogHeader>
              {/* eslint-disable-next-line @next/next/no-img-element -- 同上，模板外域配图 */}
              <img
                src={item.image}
                alt={item.title}
                className="max-h-96 w-full rounded-lg border border-neutral-800 object-cover"
              />
              {item.content}
            </DialogContent>
          </Dialog>
        ))}
      </div>
    </section>
  )
}
