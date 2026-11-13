"use client"

import { cn } from "@/lib/utils"
import { BentoCard } from "@/components/ui/bento-variant-1"

/**
 * 核心能力：Bento 功能矩阵（产品功能的第二页，紧随星空区之后）。
 * 21st.dev bento-variant-1 模板深色改造——复用 ui/bento-variant-1 的 BentoCard，
 * 区块底色与标题渐变对齐营销页深色白系（同 pricing-section 的口径，不走 shadcn token）。
 * 无锚点 id：本区属「产品功能」滚动流，导航经过时保持「产品功能」高亮。
 * 五卡叙事 = AI 创作 3 卡 + TEMU 运营 + 库存管理。
 */
export default function BentoFeaturesSection() {
  return (
    <section className="w-full bg-neutral-950 font-sans text-white">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col px-5 pb-14 pt-14 sm:px-8 lg:px-10 lg:pb-16 lg:pt-16">
        <header className="grid grid-cols-1 gap-3 lg:grid-cols-6 lg:items-end lg:gap-2">
          <h2 className="animate-fade-slide-in-1 bg-gradient-to-b from-white to-gray-400 bg-clip-text text-4xl font-bold tracking-tight text-transparent md:text-5xl lg:col-span-2">
            核心能力
          </h2>
          <p className="animate-fade-slide-in-2 bg-gradient-to-r from-white via-white/80 to-white/45 bg-clip-text text-xs font-medium tracking-tight text-transparent whitespace-nowrap sm:text-xl/7 lg:col-span-4 lg:justify-self-end lg:text-right lg:text-2xl/8">
            「好的艺术家复制，伟大的艺术家窃取灵感。」—— 毕加索
          </p>
        </header>

        <div className="mt-5 h-px w-full bg-white/10 lg:mt-6" />

        <div
          className={cn(
            "-mx-5 mt-5 flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-px-5 px-5 pb-2 sm:-mx-8 sm:scroll-px-8 sm:px-8",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "lg:mx-0 lg:mt-6 lg:grid lg:grid-cols-6 lg:overflow-visible lg:px-0 lg:pb-0",
          )}
        >
          <BentoCard
            eyebrow="模型聚合"
            title="多家前沿模型 一站式调用"
            description="聚合主流 AI 图像模型，按需切换。输入一句话，即刻产出商用级画质。"
            graphic={
              <div className="absolute inset-0 bg-cover bg-[position:70%_30%] bg-[url(https://cdn.21st.dev/assets/mirror/82/8216d38fc7b6e661002e520eceae40f036741db2f2281729f62bc2885f168bff.png)]" />
            }
            className="lg:col-span-3 lg:rounded-[2rem_0.5rem_0.5rem_0.5rem]"
          />
          <BentoCard
            eyebrow="精准控图"
            title="参考图 引导生成方向"
            description="上传参考图控制构图、配色与风格，生成结果高度可预期，返工率大幅降低。"
            graphic={
              <div className="absolute inset-0 bg-cover bg-[position:60%_40%] bg-[url(https://cdn.21st.dev/assets/mirror/38/388b12fd04fd758f8af4db4ff90a362fdefabc172e3f532d6595f2ba4a86a76b.png)]" />
            }
            className="lg:col-span-3 lg:rounded-[0.5rem_2rem_0.5rem_0.5rem]"
          />
          <BentoCard
            eyebrow="自动化"
            title="批量任务 Agent 代跑"
            description="一次提交批量生图，Agent 工作流自动执行，重复劳动交给系统，团队专注创意。"
            graphic={
              <div className="absolute inset-0 bg-black bg-cover bg-[position:30%_20%] bg-[url(https://cdn.21st.dev/assets/mirror/e1/e11e231bc3af40fd287e47edf1ae6caf40f5421f6fadee45b6e10a635ddea8c0.png)]" />
            }
            className="lg:col-span-2 lg:rounded-[0.5rem_0.5rem_0.5rem_2rem]"
          />
          <BentoCard
            eyebrow="电商运营"
            title="TEMU 全链路 一站打通"
            description="发品、发货、调价、质检全流程覆盖，多店铺统一管理，运营动作一屏完成。"
            graphic={
              <div className="absolute inset-0 bg-center bg-cover bg-[url(https://cdn.21st.dev/assets/mirror/05/05a9718924c99a9e5c6d5a61b9ea8d088c6f2ce2515716d60f69064dc178462f.png)]" />
            }
            className="lg:col-span-2 lg:rounded-[0.5rem]"
          />
          <BentoCard
            eyebrow="库存底座"
            title="自建库存 智能预警"
            description="出入库、生产、备货与 TEMU 发货联动，滞销判定与补货建议自动计算，不断货不积压。"
            graphic={
              <div className="absolute inset-0 bg-cover bg-[position:30%_20%] bg-[url(https://cdn.21st.dev/assets/mirror/1a/1aa128de57f039b2b380e36a1b540ebbabe497490bb78e07ec6ab8c8cb9383f8.png)]" />
            }
            className="lg:col-span-2 lg:rounded-[0.5rem_0.5rem_2rem_0.5rem]"
          />
        </div>
      </div>
    </section>
  )
}
