"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Copy,
  History,
  Images,
  LayoutTemplate,
  PenLine,
  RefreshCw,
  Wand2,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { endOfDay, startOfDay } from "date-fns"
import type { DateRange } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ReferenceImageUpload } from "@/components/product/reference-image-upload"
import {
  aiAssistSellingPointsAction,
  generateProductV2Action,
  generateSuiteCardPromptsAction,
  getProductBatchStatusAction,
  listProductBatchesAction,
  regenerateSuiteCardPromptAction,
  retryProductV2TaskAction,
  smartMatchStructureAction,
} from "@/server/actions/product-v2"
import {
  DirectionPicker,
  applySmartMatch,
  countSelectedImages,
  initSelections,
  type DirectionSelectionMap,
} from "./direction-picker"
import {
  SuiteStructureConfig,
  type StructureCategoryState,
} from "./structure-config"
import { SuiteCardReview } from "./card-review"
import { BatchView } from "./batch-view"
import { HistoryDateRangePicker } from "./history-date-range-picker"
import { HistoryPanel } from "./history-panel"
import type {
  AiBriefResult,
  AiDegradeReason,
  PlatformSizeSpecRow,
  ProductBatchRow,
  ProductBatchTaskRow,
  ProductDirectionRow,
  ProductLanguageOption,
  ProductModelRow,
  ProductPlatformOption,
  SmartMatchSlot,
  SuiteCard,
} from "@/lib/product/types"
import {
  PRODUCT_MODE_LABELS,
  REFINE_FIXED_KEYS,
  REPLICATE_LEVELS,
  type ProductMode,
} from "@/lib/product/dictionaries"
import type { GenerateProductV2Input } from "@/server/schemas/product-v2"

const TAB_MODES: ProductMode[] = ["suite", "detail", "replicate", "refine"]

/** 各功能 tab 图标（TabsTrigger 自动将 svg 缩放为 size-4） */
const MODE_ICONS: Record<ProductMode, LucideIcon> = {
  suite: Images,
  detail: LayoutTemplate,
  replicate: Copy,
  refine: Wand2,
}

/** 历史 tab 顶栏筛选下拉选项（全部 + 各功能类型） */
const HISTORY_FILTER_ITEMS: { value: "all" | ProductMode; label: string }[] = [
  { value: "all", label: "全部" },
  ...TAB_MODES.map((m) => ({ value: m, label: PRODUCT_MODE_LABELS[m] })),
]

/** 提交的 direction 条目（与服务端 schema 对齐） */
interface DirectionEntry {
  key: string
  count: number
  vars?: {
    angle?: string
    focus?: string
    copyHint?: string
    target?: string
  }
}

/** 各 tab 的右侧介绍文案 */
const INTRO: Record<
  ProductMode,
  { title: string; description: string; bullets: string[] }
> = {
  suite: {
    title: "AI 商品套图",
    description: "上传商品原图，一键生成整套平台合规的电商图",
    bullets: [
      "智能匹配：AI 看图规划套图结构",
      "自定义结构：白底/场景/卖点/其他组合",
      "整套风格统一，比例符合平台规范",
    ],
  },
  detail: {
    title: "A+ 详情页",
    description: "按平台规范尺寸生成 A+ 内容模块长图",
    bullets: [
      "尺寸规范：按平台（如 Amazon A+）精确出图",
      "板块化生成：首屏主视觉/卖点/场景自由组合",
      "图内文案语言跟随所选语言",
    ],
  },
  replicate: {
    title: "爆款复刻",
    description: "上传商品图 + 爆款参考图，复刻爆款视觉",
    bullets: [
      "两种复刻程度：参考风格 / 高度复刻",
      "保留自有商品主体，借鉴爆款构图",
      "出图后可继续微调补充要求",
    ],
  },
  refine: {
    title: "产品精修",
    description: "一键画质优化：去瑕疵、增光泽、校正色彩",
    bullets: [
      `${REFINE_FIXED_KEYS.length} 种快捷优化项可多选组合`,
      "保持商品主体与构图不变",
      "修复划痕/提升清晰度/修正透视",
    ],
  },
}

interface ProductClientProps {
  initialModels: ProductModelRow[]
  suiteDirections: ProductDirectionRow[]
  detailDirections: ProductDirectionRow[]
  refineDirections: ProductDirectionRow[]
  sizeSpecs: PlatformSizeSpecRow[]
  /** DB 化上架平台（超管配置；回退内置常量由 server action 保证） */
  platforms: ProductPlatformOption[]
  /** DB 化语言 */
  languages: ProductLanguageOption[]
  creditsBalance: number
}

export function ProductClient({
  initialModels,
  suiteDirections,
  detailDirections,
  refineDirections,
  sizeSpecs,
  platforms,
  languages,
  creditsBalance,
}: ProductClientProps) {
  const router = useRouter()

  // ── tab（history 是第五个视图，不参与 PRODUCT_MODES）──
  const [tab, setTab] = useState<ProductMode | "history">("suite")

  // ── 表单状态（跨 tab 持久）──
  const [referenceImages, setReferenceImages] = useState<string[]>([])
  const [benchmarkImage, setBenchmarkImage] = useState<string | null>(null)
  const [platform, setPlatform] = useState(platforms[0]?.key ?? "amazon")
  const [language, setLanguage] = useState(languages[0]?.key ?? "en")
  const [modelId, setModelId] = useState<string | null>(
    initialModels[0]?.id ?? null,
  )
  const [size, setSize] = useState<string | null>(null)
  const [sizeSpecId, setSizeSpecId] = useState<string | null>(null)
  /** 商品信息合并文本块（编号格式：1.商品名称 2.核心卖点 3.适用人群…，AI 帮写生成） */
  const [productBrief, setProductBrief] = useState("")
  /** 补充要求（仅复刻/精修的额外提示词） */
  const [additionalPrompt, setAdditionalPrompt] = useState("")
  const [replicateLevel, setReplicateLevel] = useState<"style" | "strict">(
    "style",
  )

  // ── 方向选中态（按 scope 各自独立）──
  const [suiteSelections, setSuiteSelections] = useState(() =>
    initSelections(suiteDirections),
  )
  const [detailSelections, setDetailSelections] = useState(() =>
    initSelections(detailDirections),
  )
  const [refineSelections, setRefineSelections] = useState(() =>
    initSelections(refineDirections),
  )

  // ── 套图结构配置（仅套图 tab：智能匹配 / 自定义配置）──
  const [suiteStructureMode, setSuiteStructureMode] = useState<"smart" | "custom">(
    "smart",
  )
  /** 自定义配置「其他」行：从未手动选中的方向中 AI 补充的张数 */
  const [otherSelection, setOtherSelection] = useState<StructureCategoryState>({
    selected: false,
    count: 1,
  })

  // ── 套图卡片确认阶段（config=结构配置 / cards=确认卡片）──
  const [suiteStage, setSuiteStage] = useState<"config" | "cards">("config")
  const [suiteCards, setSuiteCards] = useState<SuiteCard[]>([])
  /** 出卡过程相位文案（结构分配 → 卡片提示词生成；null=空闲） */
  const [suiteGenPhase, setSuiteGenPhase] = useState<string | null>(null)
  /** 正在重新生成的卡片下标 */
  const [regenIndex, setRegenIndex] = useState<number | null>(null)

  // ── AI 交互 ──
  const [aiWriting, setAiWriting] = useState(false)
  const [aiOverwriteOpen, setAiOverwriteOpen] = useState(false)
  const pendingAiResult = useRef<AiBriefResult | null>(null)
  const [smartState, setSmartState] = useState<"idle" | "loading" | "done">(
    "idle",
  )

  // ── 提交 / 批次 / 历史 ──
  const [submitting, setSubmitting] = useState(false)
  const [activeBatchTag, setActiveBatchTag] = useState<string | null>(null)
  const [batchTasks, setBatchTasks] = useState<ProductBatchTaskRow[]>([])
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [batches, setBatches] = useState<ProductBatchRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // ── 历史 tab 顶栏筛选：类型下拉 + 日期范围（进入历史 tab 后显示于刷新左侧）──
  const [historyModeFilter, setHistoryModeFilter] = useState<"all" | ProductMode>(
    "all",
  )
  const [historyDateRange, setHistoryDateRange] = useState<DateRange | undefined>()
  const historyFilterActive =
    historyModeFilter !== "all" || historyDateRange?.from !== undefined
  const filteredBatches = useMemo(() => {
    if (!historyFilterActive) return batches
    return batches.filter((b) => {
      if (historyModeFilter !== "all" && b.mode !== historyModeFilter)
        return false
      const created = new Date(b.createdAt)
      const { from, to } = historyDateRange ?? {}
      // 起止均含当天全天
      if (from && created < startOfDay(from)) return false
      if (to && created > endOfDay(to)) return false
      return true
    })
  }, [batches, historyModeFilter, historyDateRange, historyFilterActive])

  const selectedModel = useMemo(
    () => initialModels.find((m) => m.id === modelId) ?? null,
    [initialModels, modelId],
  )

  /** 原图上限：refine 固定 1；其余 = 模型 maxReferenceImages（≥1） */
  const maxImages = useMemo(() => {
    if (tab === "refine") return 1
    return Math.max(1, selectedModel?.maxReferenceImages ?? 3)
  }, [tab, selectedModel])

  /** 当前 tab 的方向池与选中态 */
  const { directions, selections, setSelections } = useMemo(() => {
    switch (tab) {
      case "detail":
        return {
          directions: detailDirections,
          selections: detailSelections,
          setSelections: setDetailSelections,
        }
      case "refine":
        return {
          directions: refineDirections,
          selections: refineSelections,
          setSelections: setRefineSelections,
        }
      case "replicate":
        // 复刻无方向选择：directions 为空 → ⑤ 区块不渲染
        return {
          directions: [],
          selections: suiteSelections,
          setSelections: setSuiteSelections,
        }
      default:
        return {
          directions: suiteDirections,
          selections: suiteSelections,
          setSelections: setSuiteSelections,
        }
    }
  }, [
    tab,
    suiteDirections,
    detailDirections,
    refineDirections,
    suiteSelections,
    detailSelections,
    refineSelections,
  ])

  /** 详情页 tab 的平台规范尺寸选项 */
  const platformSpecs = useMemo(
    () => sizeSpecs.filter((s) => s.platformKey === platform),
    [sizeSpecs, platform],
  )

  /** 自定义配置可见方向（前端隐藏的不显示；AI 候选池不受影响） */
  const visibleSuiteDirections = useMemo(
    () => suiteDirections.filter((d) => !d.isHidden),
    [suiteDirections],
  )

  /** 套图卡片确认阶段：左侧输入面板只显示确认区，上方配置项全部隐藏 */
  const suiteCardsStage = tab === "suite" && suiteStage === "cards"

  /** 自定义配置总张数（手动勾选方向 + 其他 AI 补充；校验/积分预估用） */
  const customStructureImages = useMemo(
    () =>
      countSelectedImages(suiteSelections) +
      (otherSelection.selected ? otherSelection.count : 0),
    [suiteSelections, otherSelection],
  )

  /** 选中项触发器显示名（Base UI Select 未传 items/children 时会显示原始 key/UUID） */
  const platformLabel =
    platforms.find((p) => p.key === platform)?.label ?? platform
  const languageLabel =
    languages.find((l) => l.key === language)?.label ?? language
  const modelLabel =
    selectedModel?.displayName || "选择模型"
  const sizeSpecLabel =
    platformSpecs.find((s) => s.id === sizeSpecId)?.label ?? "规范尺寸"
  /** 非详情 tab 的比例显示名：未选 → 通用比例；已选 → 模型预设比例名 */
  const ratioValueLabel = () => {
    if (!size) return "通用比例"
    const preset = selectedModel?.sizePresets?.find(
      (p) => `${p.width}x${p.height}` === size,
    )
    return preset ? preset.label : size
  }

  /** 任务数与积分预估 */
  const totalImages = useMemo(() => {    if (tab === "replicate") return 1
    if (tab === "refine")
      return countSelectedImages(refineSelections) > 0 ? 1 : 0
    if (tab === "suite")
      return suiteStructureMode === "smart"
        ? countSelectedImages(suiteSelections)
        : customStructureImages
    return countSelectedImages(selections)
  }, [
    tab,
    suiteStructureMode,
    suiteSelections,
    customStructureImages,
    refineSelections,
    selections,
  ])
  const unitCost = selectedModel?.costPerImage ?? 0
  const totalCost = totalImages * unitCost

  // tab 切换时收敛不合法状态（refine 单图、detail 尺寸重置）
  const handleTabChange = (value: string | null) => {
    const next = (value ?? "suite") as ProductMode | "history"
    if (next === "refine" && referenceImages.length > 1) {
      setReferenceImages((prev) => prev.slice(0, 1))
    }
    if (next === "detail" && (!sizeSpecId || !platformSpecs.some((s) => s.id === sizeSpecId))) {
      setSizeSpecId(null)
    }
    // 复刻/精修已无「跟随/保持原图」选项：未选比例时预选模型第一个预设
    if ((next === "replicate" || next === "refine") && !size) {
      const first = selectedModel?.sizePresets?.[0]
      if (first) setSize(`${first.width}x${first.height}`)
    }
    // 离开套图时丢弃卡片确认阶段（配置/模型可能已变，避免陈旧卡片误提交）
    if (next !== "suite" && tab === "suite" && suiteStage === "cards") {
      setSuiteStage("config")
      setSuiteCards([])
    }
    setTab(next)
    if (next === "history") void refreshHistory()
  }
  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      setBatches(await listProductBatchesAction())
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  // ── AI 帮写（编号格式商品信息文本块）──
  const applyAiResult = useCallback((data: AiBriefResult) => {
    setProductBrief(data.brief)
    toast.success("AI 已生成商品信息，可继续编辑")
  }, [])

  const runAiWrite = useCallback(async () => {
    if (referenceImages.length === 0) {
      toast.error("请先上传商品原图")
      return
    }
    setAiWriting(true)
    try {
      const res = await aiAssistSellingPointsAction({
        mode: tab === "detail" ? "detail" : "suite",
        referenceImages,
        platform,
        language,
      })
      if (!res.ok || !res.data) {
        toast.error(res.error ?? "AI 帮写失败，请手动填写")
        return
      }
      if (res.degraded === "no-vision") {
        toast.info("当前存储不支持看图，已基于文字生成")
      } else if (res.degraded === "ai-failed") {
        toast.info("AI 看图失败，已降级为纯文本生成")
      }
      pendingAiResult.current = res.data
      if (productBrief.trim()) {
        setAiOverwriteOpen(true) // 已有内容 → 覆盖确认
      } else {
        applyAiResult(res.data)
      }
    } finally {
      setAiWriting(false)
    }
  }, [referenceImages, tab, platform, language, productBrief, applyAiResult])

  // ── 智能匹配（套图结构分配：点「生成商品套图」时调用 / 「其他」提交时填充）──
  const fetchSmartData = useCallback(async (): Promise<
    | { ok: true; slots: SmartMatchSlot[]; degraded: AiDegradeReason }
    | { ok: false; error: string }
  > => {
    try {
      const res = await smartMatchStructureAction({
        referenceImages,
        platform,
        language,
        sellingPoints: productBrief.trim(),
      })
      if (!res.ok || !res.data) {
        return { ok: false, error: res.error ?? "AI 调用失败，请稍后重试" }
      }
      return { ok: true, slots: res.data.slots, degraded: res.degraded ?? null }
    } catch {
      return { ok: false, error: "AI 调用失败，请稍后重试" }
    }
  }, [referenceImages, platform, language, productBrief])

  /**
   * 自定义配置「其他（AI智能匹配）」：从未手动选中的方向中取 AI 匹配结果
   * 填满 N 张；AI 不可用/选不够时按方向池顺序降级填充（保证提交不卡死）。
   */
  const resolveOtherDirections = useCallback(
    async (need: number): Promise<DirectionEntry[] | null> => {
      // 已手动勾选的方向不再参与「其他」填充
      const excluded = new Set(
        Object.entries(suiteSelections)
          .filter(([, s]) => s.selected)
          .map(([key]) => key),
      )
      const dirByKey = new Map(suiteDirections.map((d) => [d.key, d]))
      const capOf = (key: string) => {
        const d = dirByKey.get(key)
        return d ? (d.supportsCount ? d.maxCount : 1) : 1
      }

      // 候选 = 未手动勾选的方向（带 AI 建议张数/定制变量；无匹配结果时现场取一次）
      let candidates: Array<{
        key: string
        count?: number
        angle?: string
        focus?: string
        copyHint?: string
        target?: string
      }> | null = null
      let aiFailed = false
      if (smartState === "done") {
        // 复用已有匹配结果：applySmartMatch 对 AI 命中的条目保留 count/vars
        candidates = Object.entries(suiteSelections)
          .filter(([, s]) => !s.selected)
          .map(([key, s]) => ({
            key,
            count: s.count,
            angle: s.vars?.angle,
            focus: s.vars?.focus,
            copyHint: s.vars?.copyHint,
            target: s.vars?.target,
          }))
      } else {
        const data = await fetchSmartData()
        if (data.ok) candidates = data.slots.filter((s) => s.selected)
        else aiFailed = true
      }

      const picked: DirectionEntry[] = []
      let remaining = need
      if (candidates) {
        for (const cand of candidates) {
          if (remaining <= 0) break
          if (excluded.has(cand.key)) continue
          if (!dirByKey.has(cand.key)) continue
          const count = Math.min(remaining, cand.count ?? 1, capOf(cand.key))
          if (count <= 0) continue
          picked.push({
            key: cand.key,
            count,
            vars:
              cand.angle || cand.focus || cand.copyHint || cand.target
                ? {
                    angle: cand.angle,
                    focus: cand.focus,
                    copyHint: cand.copyHint,
                    target: cand.target,
                  }
                : undefined,
          })
          remaining -= count
        }
      }
      // 缺口按方向池顺序补足
      for (const d of suiteDirections) {
        if (remaining <= 0) break
        if (excluded.has(d.key) || picked.some((p) => p.key === d.key)) continue
        const count = Math.min(remaining, capOf(d.key))
        picked.push({ key: d.key, count })
        remaining -= count
      }
      // 仍不足：在已选方向间轮转 +1（不超各自上限）
      while (remaining > 0) {
        let progressed = false
        for (const p of picked) {
          if (remaining <= 0) break
          if (p.count < capOf(p.key)) {
            p.count++
            remaining--
            progressed = true
          }
        }
        if (!progressed) break
      }

      if (picked.length === 0) return null
      if (aiFailed || remaining > 0) {
        toast.info("AI 匹配「其他」图型未完全可用，已按推荐结构填充")
      }
      return picked
    },
    [smartState, suiteSelections, suiteDirections, fetchSmartData],
  )

  // ── 套图出卡：结构分配（智能/自定义）→ 批量生成卡片提示词 ──

  /** SmartMatchSlot 的四项定制 → 提交 vars 形状 */
  const varsOf = (s: SmartMatchSlot) =>
    s.angle || s.focus || s.copyHint || s.target
      ? {
          angle: s.angle,
          focus: s.focus,
          copyHint: s.copyHint,
          target: s.target,
        }
      : undefined

  /**
   * 套图生成入口（配置阶段点击「生成商品套图」）：
   * 智能匹配 → AI 分配 7~9 张结构；自定义 → 手动勾选 + 「其他」AI 补充；
   * 之后一次 AI 调用批量生成卡片画面提示词，进入卡片确认阶段。
   */
  const runSuiteGenerate = async () => {
    if (!modelId) return toast.error("请选择图片模型")
    if (referenceImages.length === 0) return toast.error("请上传商品原图")
    if (!productBrief.trim())
      return toast.error("请填写商品信息（可用 AI 帮写）")

    setSuiteGenPhase("AI 正在依据商品信息分配套图结构…")
    try {
      let structure: DirectionEntry[]
      if (suiteStructureMode === "smart") {
        const data = await fetchSmartData()
        if (!data.ok) {
          toast.error(`${data.error}，也可切换到自定义配置`)
          return
        }
        if (data.degraded === "no-vision") {
          toast.info("当前存储不支持看图，已基于文字匹配")
        } else if (data.degraded === "ai-failed") {
          toast.info("AI 看图失败，已降级为纯文本匹配")
        }
        // 同步到选中态（切自定义可继续编辑 / 「其他」填充可复用）
        setSuiteSelections((prev) => applySmartMatch(prev, data.slots))
        setSmartState("done")
        structure = data.slots
          .filter((s) => s.selected)
          .map((s) => ({ key: s.key, count: s.count ?? 1, vars: varsOf(s) }))
        if (structure.length === 0) {
          toast.error("AI 未选择任何方向，请补充商品信息后重试")
          return
        }
      } else {
        structure = selectedFromMap(suiteSelections)
        if (otherSelection.selected && otherSelection.count > 0) {
          const others = await resolveOtherDirections(otherSelection.count)
          if (!others) {
            toast.error("其余方向池为空，无法填充「其他」图型")
            return
          }
          structure.push(...others)
        }
        if (structure.length === 0) {
          toast.error("请至少选择 1 个方向")
          return
        }
      }

      // 结构展开为逐卡输入（count 张 = count 张独立卡片）
      const cardInputs = structure.flatMap((e) =>
        Array.from({ length: e.count }, () => ({
          directionKey: e.key,
          vars: e.vars,
        })),
      )
      setSuiteGenPhase(`AI 正在生成 ${cardInputs.length} 张卡片的画面提示词…`)
      const res = await generateSuiteCardPromptsAction({
        platform,
        language,
        referenceImages,
        sellingPoints: productBrief,
        cards: cardInputs,
      })
      if (!res.ok || !res.cards) {
        toast.error(res.error ?? "生成卡片失败，请重试")
        return
      }
      setSuiteCards(res.cards)
      setSuiteStage("cards")
    } finally {
      setSuiteGenPhase(null)
    }
  }

  /** 单卡重新生成画面提示词（独立 AI 调用，可重试单张） */
  const regenCard = async (index: number) => {
    const card = suiteCards[index]
    if (!card) return
    setRegenIndex(index)
    try {
      const res = await regenerateSuiteCardPromptAction({
        platform,
        language,
        referenceImages,
        sellingPoints: productBrief,
        card: { directionKey: card.directionKey, vars: card.vars },
      })
      if (!res.ok || !res.prompt) {
        toast.error(res.error ?? "重新生成失败，请重试")
        return
      }
      setSuiteCards((prev) =>
        prev.map((c, i) => (i === index ? { ...c, prompt: res.prompt! } : c)),
      )
    } finally {
      setRegenIndex(null)
    }
  }

  /** 卡片确认 → 生图（此时才校验积分并扣费） */
  const confirmCards = async () => {
    if (!modelId) {
      toast.error("请选择图片模型")
      return
    }
    if (suiteCards.length === 0) {
      toast.error("卡片已全部删除，请返回修改")
      return
    }
    if (suiteCards.some((c) => !c.prompt.trim())) {
      toast.error("存在空白提示词的卡片，请填写或删除")
      return
    }
    const total = suiteCards.length * unitCost
    if (creditsBalance < total) {
      toast.error(
        `个人配额不足，还需 ${total - creditsBalance} 积分，请联系管理员分配`,
      )
      return
    }
    const fallbackSize = selectedModel?.sizePresets?.[0]
      ? `${selectedModel.sizePresets[0].width}x${selectedModel.sizePresets[0].height}`
      : undefined
    setSubmitting(true)
    try {
      await postSubmit({
        mode: "suite",
        modelId,
        referenceImages,
        platform,
        language,
        size: sizeSpecId ? undefined : size ?? fallbackSize,
        sizeSpecId: sizeSpecId ?? undefined,
        sellingPoints: productBrief || undefined,
        cards: suiteCards.map((c) => ({
          directionKey: c.directionKey,
          directionName: c.directionName,
          prompt: c.prompt.trim(),
        })),
      })
      // 回到配置阶段（结果由批次进度面板承接）
      setSuiteStage("config")
      setSuiteCards([])
    } finally {
      setSubmitting(false)
    }
  }

  // ── 提交 ──
  /** 选中态 Map → 提交条目（detail / refine 共用） */
  const selectedFromMap = (map: DirectionSelectionMap): DirectionEntry[] =>
    Object.entries(map)
      .filter(([, s]) => s.selected)
      .map(([key, s]) => ({
        key,
        count: s.count,
        vars: s.vars
          ? {
              angle: s.vars.angle,
              focus: s.vars.focus,
              copyHint: s.vars.copyHint,
              target: s.vars.target,
            }
          : undefined,
      }))

  /** 构建非套图 tab 的提交入参（套图走卡片确认路径 confirmCards） */
  const buildInput = async () => {
    let directionEntries: DirectionEntry[] | undefined
    if (tab === "detail" || tab === "refine") {
      directionEntries = selectedFromMap(selections)
      if (directionEntries.length === 0) directionEntries = undefined
    }
    // replicate：无方向字段

    // 比例兜底：未选比例时取模型第一个预设；两者皆无则留空（服务端兜底 1024x1024）
    const fallbackSize = selectedModel?.sizePresets?.[0]
      ? `${selectedModel.sizePresets[0].width}x${selectedModel.sizePresets[0].height}`
      : undefined

    return {
      mode: tab as ProductMode,
      modelId: modelId!,
      referenceImages,
      benchmarkImage: tab === "replicate" ? benchmarkImage ?? undefined : undefined,
      platform: tab === "refine" ? undefined : platform,
      language: tab === "refine" ? undefined : language,
      size:
        tab === "replicate" || tab === "refine"
          ? size ?? fallbackSize
          : undefined,
      sizeSpecId: tab === "detail" ? sizeSpecId ?? undefined : undefined,
      sellingPoints:
        tab === "refine" || tab === "replicate" ? undefined : productBrief || undefined,
      additionalPrompt:
        tab === "replicate" || tab === "refine" ? additionalPrompt || undefined : undefined,
      directions: directionEntries,
      replicateLevel: tab === "replicate" ? replicateLevel : undefined,
    }
  }

  const trySubmit = () => {
    // 客户端预检（服务端 zod 兜底），通过后直接提交（无扣费确认弹窗）
    if (!modelId) return toast.error("请选择图片模型")
    if (referenceImages.length === 0) return toast.error("请上传商品原图")
    if (tab === "refine" && referenceImages.length !== 1)
      return toast.error("产品精修仅支持 1 张原图")
    if (tab === "replicate" && !benchmarkImage)
      return toast.error("请上传爆款参考图")
    if (
      (tab === "suite" || tab === "detail") &&
      !productBrief.trim()
    )
      return toast.error("请填写商品信息（可用 AI 帮写）")
    if (tab === "suite") {
      // 套图：结构分配 + 出卡，卡片确认后才真正扣费生图
      if (suiteStructureMode === "custom" && totalImages === 0)
        return toast.error("整个套图至少需要选择 1 张图")
      void runSuiteGenerate()
      return
    }
    if (totalImages === 0)
      return toast.error(
        tab === "refine" ? "请至少选择 1 个优化项" : "请至少选择 1 个方向",
      )
    if (tab === "detail" && !sizeSpecId)
      return toast.error("A+详情页请选择平台规范尺寸")
    if (creditsBalance < totalCost)
      return toast.error(
        `个人配额不足，还需 ${totalCost - creditsBalance} 积分，请联系管理员分配`,
      )
    void submit()
  }

  /** 通用提交段（方向路径 detail/refine 与套图卡片路径共用）：提交 → 批次轮询 */
  const postSubmit = async (input: GenerateProductV2Input) => {
    const res = await generateProductV2Action(input)
    if (!res.ok || !res.batchTag) {
      toast.error(res.error ?? "提交失败")
      return
    }
    setActiveBatchTag(res.batchTag)
    setBatchTasks([])
    toast.success(
      `已提交 ${res.taskIds?.length ?? 0} 个任务，扣费 ${res.totalCost ?? 0} 积分`,
    )
    router.refresh()
  }

  const submit = async () => {
    setSubmitting(true)
    try {
      let input
      try {
        input = await buildInput()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "任务构建失败")
        return
      }
      await postSubmit(input)
    } finally {
      setSubmitting(false)
    }
  }

  // ── 批次轮询（5s；页面隐藏暂停；全部终态停止）──
  useEffect(() => {
    if (!activeBatchTag) return
    let stop = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const tasks = await getProductBatchStatusAction(activeBatchTag)
        if (stop) return
        setBatchTasks(tasks)
        const allDone = tasks.every(
          (t) => t.status === "completed" || t.status === "failed",
        )
        if (allDone) {
          router.refresh()
          if (tasks.some((t) => t.status === "failed")) {
            const refunded = tasks.reduce((s, t) => s + t.refunded, 0)
            toast.warning(
              `批次完成（失败已退 ${refunded} 积分，可单张重试）`,
            )
          } else {
            toast.success("套图生成完成")
          }
        }
        return allDone
      } catch {
        return false
      }
    }
    const timer = setInterval(async () => {
      const done = await tick()
      if (done) clearInterval(timer)
    }, 5000)
    void tick()
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [activeBatchTag, router])

  const retryTask = async (taskId: string) => {
    setRetryingId(taskId)
    try {
      const res = await retryProductV2TaskAction(taskId)
      if (!res.ok) {
        toast.error(res.error ?? "重试失败")
        return
      }
      toast.success("已重新入队")
      // 立即刷新一次状态
      if (activeBatchTag) {
        setBatchTasks(await getProductBatchStatusAction(activeBatchTag))
      }
    } finally {
      setRetryingId(null)
    }
  }

  const intro = tab !== "history" ? INTRO[tab] : null

  return (
    /* 7rem = inset 侧栏上下 m-2(各8px) + 顶栏 h-16(64px) + 内容区 p-4(上下各16px)，改壳层高度需同步 */
    <div className="flex flex-col gap-4 lg:h-[calc(100svh-7rem)] lg:overflow-hidden">
      {/* 顶部行：左侧功能 tab（固定，不随面板滚动）+ 右侧生成历史入口 */}
      <div className="flex shrink-0 items-center justify-between gap-4">
        <Tabs
          value={tab}
          onValueChange={(v) => handleTabChange(v as string)}
          className="min-w-0"
        >
          <TabsList>
            {TAB_MODES.map((m) => {
              const Icon = MODE_ICONS[m]
              return (
                <TabsTrigger key={m} value={m} className="px-3">
                  <Icon />
                  {PRODUCT_MODE_LABELS[m]}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>
        <div className="flex shrink-0 items-center gap-2">
          {tab === "history" && (
            <>
              <HistoryDateRangePicker
                value={historyDateRange}
                onChange={setHistoryDateRange}
              />
              <Select
                value={historyModeFilter}
                onValueChange={(v) =>
                  setHistoryModeFilter((v as "all" | ProductMode) ?? "all")
                }
              >
                <SelectTrigger aria-label="筛选生成类型">
                  <SelectValue>
                    {HISTORY_FILTER_ITEMS.find(
                      (i) => i.value === historyModeFilter,
                    )?.label ?? "全部"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="min-w-32">
                  {HISTORY_FILTER_ITEMS.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="default"
                disabled={historyLoading}
                onClick={() => void refreshHistory()}
              >
                {historyLoading ? (
                  <MorphingInfinity className="mr-1 size-3.5" />
                ) : (
                  <RefreshCw className="mr-1 size-3.5" />
                )}
                刷新
              </Button>
            </>
          )}
          <Button
            type="button"
            variant={tab === "history" ? "default" : "outline"}
            size="default"
            className="shrink-0"
            onClick={() => handleTabChange("history")}
          >
            <History />
            生成历史
          </Button>
        </div>
      </div>

      {tab === "history" ? (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
          <HistoryPanel
            batches={filteredBatches}
            onRetry={(id) => void retryTask(id)}
            retryingId={retryingId}
            loading={historyLoading}
            filterActive={historyFilterActive}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[380px_1fr] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
          {/* ── 左侧：功能输入面板（固定高度内滚动，隐藏滚动条）── */}
          <div className="space-y-4 rounded-xl border bg-card p-4 lg:min-h-0 lg:overflow-y-auto scrollbar-hide">
            {/* ① 商品原图（卡片确认阶段隐藏） */}
            {!suiteCardsStage && (
              <div className="space-y-2">
                <Label>
                  商品原图
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    {tab === "refine"
                      ? "支持 1 张"
                      : `支持 1-${maxImages} 张（依模型上限），多角度效果更佳`}
                  </span>
                </Label>
                <ReferenceImageUpload
                  images={referenceImages}
                  onChange={setReferenceImages}
                  maxImages={maxImages}
                />
              </div>
            )}

            {/* 复刻 tab：爆款参考图 + 复刻程度 */}
            {tab === "replicate" && (
              <>
                <div className="space-y-2">
                  <Label>参考图（爆款图）</Label>
                  <ReferenceImageUpload
                    images={benchmarkImage ? [benchmarkImage] : []}
                    onChange={(imgs) => setBenchmarkImage(imgs[0] ?? null)}
                    maxImages={1}
                  />
                </div>
                <div className="space-y-2">
                  <Label>复刻程度</Label>
                  <div className="grid grid-cols-1 gap-2">
                    {REPLICATE_LEVELS.map((r) => (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => setReplicateLevel(r.value)}
                        className={
                          "rounded-lg border p-2.5 text-left text-sm transition-colors " +
                          (replicateLevel === r.value
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/50")
                        }
                      >
                        <span className="block font-medium">{r.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {r.description}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ② 上架平台 / 语言（DB 化配置，超管可维护；卡片确认阶段隐藏） */}
            {tab !== "refine" && !suiteCardsStage && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label>上架平台</Label>
                  <Select
                    value={platform}
                    onValueChange={(v) => setPlatform(v ?? platforms[0]?.key ?? "amazon")}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>{platformLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {platforms.map((p) => (
                        <SelectItem key={p.key} value={p.key}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>语言</Label>
                  <Select
                    value={language}
                    onValueChange={(v) => setLanguage(v ?? languages[0]?.key ?? "en")}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>{languageLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {languages.map((l) => (
                        <SelectItem key={l.key} value={l.key}>
                          {l.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* ③ 图片模型（虚拟名）/ 图片比例（只显示比例名；卡片确认阶段隐藏） */}
            {!suiteCardsStage && (
              <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>图片模型</Label>
                <Select
                  value={modelId ?? ""}
                  onValueChange={(v) => {
                    setModelId(v ?? null)
                    setSize(null)
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择模型">{modelLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {initialModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="flex items-center gap-1">
                          {m.displayName}
                          {m.apiFormat === "jimeng" && (
                            <span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-600 dark:text-amber-400">
                              英文文字较弱
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>图片比例</Label>
                {tab === "detail" ? (
                  <Select
                    value={sizeSpecId ?? ""}
                    onValueChange={(v) => setSizeSpecId(v ?? null)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="规范尺寸">{sizeSpecLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {platformSpecs.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select
                    value={size ?? ""}
                    onValueChange={(v) => setSize(v || null)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="通用比例">
                        {ratioValueLabel()}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(selectedModel?.sizePresets ?? []).map((p) => {
                        const v = `${p.width}x${p.height}`
                        return (
                          <SelectItem key={v} value={v}>
                            {p.label}
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                )}
              </div>
              </div>
            )}

            {/* ④a 快捷优化项（精修：置于补充要求上方，上图标下文字卡片） */}
            {tab === "refine" && directions.length > 0 && (
              <div className="space-y-2">
                <Label>快捷优化项</Label>
                <DirectionPicker
                  directions={directions}
                  selections={selections}
                  onSelectionsChange={setSelections}
                  compact
                />
              </div>
            )}

            {/* ④ 商品卖点 & 要求（合并单输入框，编号格式；卡片确认阶段隐藏） */}
            {(tab === "suite" || tab === "detail") && !suiteCardsStage && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>商品卖点 & 要求</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => void runAiWrite()}
                    disabled={aiWriting}
                  >
                    {aiWriting ? (
                      <PenLine className="mr-1 size-3 animate-pen-write text-primary" />
                    ) : (
                      <PenLine className="mr-1 size-3 text-primary" />
                    )}
                    AI 帮写
                  </Button>
                </div>
                <Textarea
                  value={productBrief}
                  onChange={(e) => setProductBrief(e.target.value)}
                  placeholder={
                    "建议包含以下信息生成更精准：\n1.产品名称\n2.核心卖点\n3.适用人群\n4.期望场景\n5.具体参数"
                  }
                  rows={8}
                  className="text-sm"
                />
              </div>
            )}
            {(tab === "replicate" || tab === "refine") && (
              <div className="space-y-2">
                <Label>补充要求</Label>
                <Textarea
                  value={additionalPrompt}
                  onChange={(e) => setAdditionalPrompt(e.target.value)}
                  placeholder="补充要求（可选），如：保持背景不变、突出金属质感…"
                  rows={3}
                  className="text-sm"
                />
              </div>
            )}

            {/* ⑤ 套图：结构配置（配置阶段）/ 卡片确认（确认阶段）；详情=可选择的方向；复刻无此区块 */}
            {tab === "suite" && suiteStage === "cards" && (
              <SuiteCardReview
                cards={suiteCards}
                unitCost={unitCost}
                submitting={submitting}
                regeneratingIndex={regenIndex}
                onCardsChange={setSuiteCards}
                onRegen={(i) => void regenCard(i)}
                onBack={() => {
                  setSuiteStage("config")
                  setSuiteCards([])
                }}
                onConfirm={() => void confirmCards()}
              />
            )}
            {tab === "suite" && suiteStage === "config" &&
              visibleSuiteDirections.length > 0 && (
              <SuiteStructureConfig
                mode={suiteStructureMode}
                onModeChange={setSuiteStructureMode}
                directions={visibleSuiteDirections}
                selections={suiteSelections}
                onSelectionsChange={setSuiteSelections}
                other={otherSelection}
                onOtherChange={setOtherSelection}
                totalImages={totalImages}
              />
            )}
            {tab === "detail" && directions.length > 0 && (
              <div className="space-y-2">
                <Label>可选择的方向</Label>
                <DirectionPicker
                  directions={directions}
                  selections={selections}
                  onSelectionsChange={setSelections}
                  hideCount
                />
              </div>
            )}

            {/* 底部：生成（套图卡片确认阶段由卡片区自带按钮，此处隐藏） */}
            {!(tab === "suite" && suiteStage === "cards") && (
              <div className="border-t pt-3">
                <Button
                  className="w-full"
                  onClick={trySubmit}
                  disabled={submitting || suiteGenPhase !== null}
                >
                  {suiteGenPhase ? (
                    <>
                      <MorphingInfinity className="mr-1 size-4" />
                      {suiteGenPhase}
                    </>
                  ) : (
                    <>
                      <Wand2 className="mr-1 size-4" />
                      {tab === "suite" && "生成商品套图"}
                      {tab === "detail" && "生成详情页"}
                      {tab === "replicate" && "一键复刻生成"}
                      {tab === "refine" && "生成商品精修"}
                      （{tab === "suite" && suiteStructureMode === "smart"
                        ? "7~9 张"
                        : `${totalCost}积分`}
                      ）
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>

          {/* ── 右侧：内容区（固定板块；结果网格内部滚动，隐藏滚动条）── */}
          <div className="rounded-xl border bg-card p-6 lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden">
            {activeBatchTag ? (
              <BatchView
                tasks={batchTasks}
                onRetry={(id) => void retryTask(id)}
                retryingId={retryingId}
              />
            ) : (
              intro && <IntroPanel mode={tab} intro={intro} />
            )}
          </div>
        </div>
      )}

      {/* 覆盖确认（AI 帮写） */}
      <Dialog open={aiOverwriteOpen} onOpenChange={setAiOverwriteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>覆盖现有内容？</DialogTitle>
          <DialogDescription>
            AI 帮写结果将覆盖当前已填写的商品信息。
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAiOverwriteOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (pendingAiResult.current) applyAiResult(pendingAiResult.current)
                setAiOverwriteOpen(false)
              }}
            >
              覆盖
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 右侧介绍区（未提交时） */
function IntroPanel({
  mode,
  intro,
}: {
  mode: ProductMode
  intro: { title: string; description: string; bullets: string[] }
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 py-10 text-center">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">{intro.title}</h2>
        <p className="text-sm text-muted-foreground">{intro.description}</p>
      </div>

      {/* 示例流程：原图 → 生成 */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <div className="flex size-24 items-center justify-center rounded-lg border-2 border-dashed border-border text-xs text-muted-foreground">
          商品原图
        </div>
        <span className="text-muted-foreground">→</span>
        {(mode === "replicate" || mode === "refine"
          ? [null]
          : [null, null, null, null]
        ).map((_, i) => (
          <div
            key={i}
            className="flex size-24 items-center justify-center rounded-lg border bg-gradient-to-br from-primary/5 to-primary/15 text-xs text-muted-foreground"
          >
            生成图 {i + 1}
          </div>
        ))}
      </div>

      <ul className="space-y-1.5 text-left text-sm text-muted-foreground">
        {intro.bullets.map((b) => (
          <li key={b} className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-primary" />
            {b}
          </li>
        ))}
      </ul>
    </div>
  )
}
