"use client"

import * as React from "react"
import {
  AlertCircle,
  ArrowLeft,
  FileSpreadsheet,
  History,
  Image as ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SmartImage } from "@/components/ui/smart-image"
import { HistoryDateRangePicker } from "@/components/product-v2/history-date-range-picker"
import type { MockupBindingDef } from "@/db/schema"
import type {
  MockupBatchPageData,
  MockupExternalTemplateView,
  MockupLibraryImage,
} from "@/lib/mockup/types"
import { toImageSrc } from "@/lib/utils"
import {
  getExternalTemplateDetailAction,
  listExternalTemplatesAction,
  listMockupDesignAssetsAction,
  prewarmMockupAssetsAction,
  submitMockupBatchAction,
} from "@/server/actions/mockup"
import { ImageLibraryDialog } from "./image-library-dialog"
import { MockupHistoryPanel } from "./mockup-history-panel"
import { MockupPageTabs } from "./mockup-page-tabs"
import { TemplateManageDialog } from "./template-manage-dialog"
import { useMockupHistory } from "./use-mockup-history"
import { ExternalTemplateCard } from "./template-picker"
import {
  MockupOutputFormatSelect,
  type MockupOutputFormat,
} from "./output-format-select"

/**
 * 样机批量替换（/mockup/batch）
 *
 * 三步：① 选已发布小模板（支持模板管理带参直达）→ ② 配置替换源：
 * 图片绑定 = 素材图片轮换（图片库多选）/ 固定图（图库/AI 生成背景），
 * 文字绑定 = CSV 列轮换 / 固定文本 → ③ 确认 N 张 × 单价扣费提交。
 * 轮换素材选自图片库并已预导入外部渲染服务，提交时不再等待上传/导入。
 * 提交后进入批次详情：进度轮询、失败重试、逐张/打包下载。
 */

/** 轻量 CSV/TSV 解析（处理引号转义、\r\n、BOM） */
function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "")
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let inQuotes = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === "," || ch === "\t") {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++
      row.push(cell)
      cell = ""
      if (row.some((c) => c.trim() !== "")) rows.push(row)
      row = []
    } else {
      cell += ch
    }
  }
  row.push(cell)
  if (row.some((c) => c.trim() !== "")) rows.push(row)
  return rows
}

/* ─── 主组件 ─── */

/** 轮换素材项（图片库图片）：prewarming = 外部渲染素材预导入中 */
interface BatchImageItem {
  url: string
  name: string
  status: "prewarming" | "ready" | "failed"
  error?: string
}

interface BatchConfigState {
  imageModes: Record<string, "batch" | "fixed">
  batchFiles: Record<string, BatchImageItem[]>
  fixedImages: Record<string, string | undefined>
  fixedTexts: Record<string, string>
  textModes: Record<string, "batch" | "fixed">
}

export function MockupBatchClient({
  initialData,
  initialTemplateId,
  isAdmin,
  currentUserId,
}: {
  initialData: MockupBatchPageData
  initialTemplateId: string | null
  isAdmin: boolean
  currentUserId: string
}) {
  const router = useRouter()
  const [templates, setTemplates] = React.useState<MockupExternalTemplateView[]>([])
  const [templatesLoading, setTemplatesLoading] = React.useState(false)
  const [keyword, setKeyword] = React.useState("")
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [selectedTemplate, setSelectedTemplate] = React.useState<{
    templateId: string
    name: string
    bindings: MockupBindingDef[]
  } | null>(null)

  const [config, setConfig] = React.useState<BatchConfigState>({
    imageModes: {},
    batchFiles: {},
    fixedImages: {},
    fixedTexts: {},
    textModes: {},
  })
  const [csvName, setCsvName] = React.useState<string | null>(null)
  const [csvRows, setCsvRows] = React.useState<string[][] | null>(null)
  const [pickerBinding, setPickerBinding] = React.useState<string | null>(null)
  /** 素材图片（多选图片库）目标绑定 */
  const [materialBinding, setMaterialBinding] = React.useState<string | null>(null)
  const [manageOpen, setManageOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  // 渲染导出格式（提交时选择；默认 PNG）
  const [outputFormat, setOutputFormat] =
    React.useState<MockupOutputFormat>("png")
  const [designAssets, setDesignAssets] = React.useState<
    Array<{ id: string; imageUrl: string; fileName: string | null }>
  >([])

  const csvInputRef = React.useRef<HTMLInputElement>(null)

  // ── 生成历史视图（来源切换/日期筛选/加载轮询见 use-mockup-history）──
  const [showHistory, setShowHistory] = React.useState(false)
  const history = useMockupHistory("batch")

  const loadTemplates = React.useCallback(async () => {
    setTemplatesLoading(true)
    try {
      const res = await listExternalTemplatesAction()
      if (!res.ok) {
        toast.error(res.error ?? "模板列表获取失败")
        return
      }
      setTemplates(res.templates)
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  const selectTemplate = React.useCallback(
    async (templateId: string | null) => {
      if (!templateId) {
        setSelectedTemplate(null)
        return
      }
      setDetailLoading(true)
      try {
        const res = await getExternalTemplateDetailAction(templateId)
        if (!res.ok || !res.detail) {
          toast.error(res.error ?? "模板详情获取失败")
          return
        }
        if (!res.detail.published) {
          toast.error("该模板未发布，不能批量替换")
          return
        }
        const bindings = res.detail.bindings
        setSelectedTemplate({
          templateId: res.detail.templateId,
          name: res.detail.name,
          bindings,
        })
        // 默认：非背景图片绑定=轮换；背景图片绑定=固定；文字=轮换
        const imageModes: Record<string, "batch" | "fixed"> = {}
        const textModes: Record<string, "batch" | "fixed"> = {}
        for (const b of bindings) {
          if (b.type === "text") textModes[b.bindingId] = "batch"
          else imageModes[b.bindingId] = b.role === "background" ? "fixed" : "batch"
        }
        setConfig({
          imageModes,
          batchFiles: {},
          fixedImages: {},
          fixedTexts: {},
          textModes,
        })
        setCsvRows(null)
        setCsvName(null)
      } finally {
        setDetailLoading(false)
      }
    },
    [],
  )

  // 初始化：模板列表 + 我的上传图库 + URL 带参直达
  React.useEffect(() => {
    void loadTemplates()
    void listMockupDesignAssetsAction().then((res) => {
      if (res.ok) setDesignAssets(res.images)
    })
  }, [loadTemplates])

  React.useEffect(() => {
    if (initialTemplateId && templates.length > 0) {
      const hit = templates.find((t) => t.templateId === initialTemplateId)
      if (hit?.published) void selectTemplate(hit.templateId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTemplateId, templates.length])

  /* ── 配置派生 ── */
  const imageDefs = (selectedTemplate?.bindings ?? []).filter((b) => b.type !== "text")
  const textDefs = (selectedTemplate?.bindings ?? []).filter((b) => b.type === "text")

  const batchImageIds = imageDefs.filter(
    (b) => config.imageModes[b.bindingId] === "batch",
  )
  const batchTextIds = textDefs.filter(
    (b) => config.textModes[b.bindingId] === "batch",
  )

  const fileCounts = batchImageIds.map(
    (b) => config.batchFiles[b.bindingId]?.length ?? 0,
  )
  const imageTaskCount = fileCounts.length > 0 ? Math.max(...fileCounts) : 0
  const csvDataRows = csvRows ? Math.max(csvRows.length - 1, 0) : 0
  const taskCount =
    imageTaskCount > 0 ? imageTaskCount : batchTextIds.length > 0 ? csvDataRows : 0

  /** CSV 列头 → 文字绑定 映射（label/bindingId 归一匹配） */
  const csvMapping = React.useMemo(() => {
    const map = new Map<string, number>()
    if (!csvRows || csvRows.length === 0) return map
    const header = csvRows[0]!
    const norm = (s: string) => s.trim().toLowerCase()
    header.forEach((h, idx) => {
      const def = textDefs.find(
        (d) => norm(d.label) === norm(h) || norm(d.bindingId) === norm(h),
      )
      if (def && !map.has(def.bindingId)) map.set(def.bindingId, idx)
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csvRows, selectedTemplate])

  const batchTextsPreview: Record<string, string[]> = React.useMemo(() => {
    const out: Record<string, string[]> = {}
    if (!csvRows) return out
    for (const b of batchTextIds) {
      const col = csvMapping.get(b.bindingId)
      out[b.bindingId] = csvRows.slice(1).map((r) => (col != null ? (r[col] ?? "") : ""))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csvRows, csvMapping, selectedTemplate, config.textModes])

  const firstBatchImageBinding = batchImageIds.find(
    (b) => (config.batchFiles[b.bindingId]?.length ?? 0) > 0,
  )
  const labels: string[] = React.useMemo(() => {
    if (firstBatchImageBinding) {
      return (config.batchFiles[firstBatchImageBinding.bindingId] ?? []).map(
        (f) => f.name,
      )
    }
    const firstText = batchTextIds[0]
    if (firstText) return batchTextsPreview[firstText.bindingId] ?? []
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.batchFiles, batchTextsPreview, firstBatchImageBinding])

  // 未选素材的轮换绑定不参与替换（提交时不进入 batchImages），等长比对只看已选素材的绑定
  const activeFileCounts = fileCounts.filter((n) => n > 0)
  const countsMismatch =
    activeFileCounts.length > 1 && new Set(activeFileCounts).size > 1

  const allMaterials = batchImageIds.flatMap((b) => config.batchFiles[b.bindingId] ?? [])
  const materialsPreparing = allMaterials.some((it) => it.status === "prewarming")
  const materialsFailedCount = allMaterials.filter((it) => it.status === "failed").length

  /** 把指定 url 的素材项置为指定状态（prewarmAndUpdate 内部用） */
  const patchBatchItems = (
    bindingId: string,
    urls: string[],
    patch: { status: BatchImageItem["status"]; error?: string },
  ) => {
    const set = new Set(urls)
    setConfig((prev) => ({
      ...prev,
      batchFiles: {
        ...prev.batchFiles,
        [bindingId]: (prev.batchFiles[bindingId] ?? []).map((it) =>
          set.has(it.url) ? { ...it, ...patch, error: patch.error } : it,
        ),
      },
    }))
  }

  /** 素材预导入（填充外部 assetId 缓存）：逐 url 独立成败，完成后转 ready/failed */
  const prewarmAndUpdate = async (bindingId: string, urls: string[]) => {
    if (urls.length === 0) return
    patchBatchItems(bindingId, urls, { status: "prewarming" })
    let res: Awaited<ReturnType<typeof prewarmMockupAssetsAction>>
    try {
      res = await prewarmMockupAssetsAction({ imageUrls: urls })
    } catch {
      // 请求层失败（网络中断/网关超时/热重载）：转 failed 交由「重试失败项」
      // 接管，避免素材永久停在准备中卡死提交按钮
      patchBatchItems(bindingId, urls, {
        status: "failed",
        error: "预导入请求中断，请重试",
      })
      return
    }
    if (!res.ok) {
      patchBatchItems(bindingId, urls, { status: "failed", error: res.error ?? "预导入失败" })
      return
    }
    const failedUrls = res.results.filter((r) => !r.ok).map((r) => r.url)
    const byUrl = new Map(res.results.filter((r) => !r.ok).map((r) => [r.url, r.error]))
    if (failedUrls.length > 0) {
      patchBatchItems(bindingId, failedUrls, {
        status: "failed",
        error: byUrl.get(failedUrls[0]!) ?? "预导入失败",
      })
      toast.error(
        `${failedUrls.length} 张素材预导入失败：${byUrl.get(failedUrls[0]!) ?? "未知原因"}`,
      )
    }
    const okUrls = res.results.filter((r) => r.ok).map((r) => r.url)
    if (okUrls.length > 0) patchBatchItems(bindingId, okUrls, { status: "ready" })
  }

  /** 图片库多选确认 → 写入轮换素材，仅对新增 url 预导入（已就绪的不重复调用） */
  const handleSelectMaterials = (bindingId: string, images: MockupLibraryImage[]) => {
    const prevItems = config.batchFiles[bindingId] ?? []
    const readyUrls = new Set(
      prevItems.filter((it) => it.status === "ready").map((it) => it.url),
    )
    const items: BatchImageItem[] = images.map((m) => {
      const url = m.imageUrl
      const prev = prevItems.find((it) => it.url === url)
      if (prev && (prev.status === "ready" || prev.status === "prewarming")) return prev
      return {
        url,
        name: m.fileName ?? url.split("/").pop() ?? "图片",
        status: "prewarming",
      }
    })
    setConfig((prev) => ({
      ...prev,
      batchFiles: { ...prev.batchFiles, [bindingId]: items },
    }))
    const newUrls = items
      .filter((it) => it.status === "prewarming" && !readyUrls.has(it.url))
      .map((it) => it.url)
    if (newUrls.length > 0) void prewarmAndUpdate(bindingId, newUrls)
  }

  /** 重试该绑定下预导入失败的素材 */
  const retryPrewarm = (bindingId: string) => {
    const failed = (config.batchFiles[bindingId] ?? []).filter((it) => it.status === "failed")
    if (failed.length === 0) return
    void prewarmAndUpdate(
      bindingId,
      failed.map((it) => it.url),
    )
  }

  /** 移除该绑定下预导入失败的素材 */
  const removeFailedMaterials = (bindingId: string) => {
    setConfig((prev) => ({
      ...prev,
      batchFiles: {
        ...prev.batchFiles,
        [bindingId]: (prev.batchFiles[bindingId] ?? []).filter((it) => it.status !== "failed"),
      },
    }))
  }

  const handleCsvSelected = async (file: File | undefined) => {
    if (!file) return
    try {
      const text = await file.text()
      const rows = parseCsv(text)
      if (rows.length < 2) {
        toast.error("表格至少需要表头 + 1 行数据")
        return
      }
      setCsvRows(rows)
      setCsvName(file.name)
      toast.success(`已解析 ${rows.length - 1} 行数据`)
    } catch {
      toast.error("表格解析失败，请使用 UTF-8 编码的 CSV 文件")
    } finally {
      if (csvInputRef.current) csvInputRef.current.value = ""
    }
  }

  const handleSubmit = async () => {
    if (!selectedTemplate) return
    if (taskCount === 0) {
      toast.error("请先选择素材图片或上传文字表格")
      return
    }
    if (materialsPreparing) {
      toast.error("素材仍在准备中，请稍候再提交")
      return
    }
    if (materialsFailedCount > 0) {
      toast.error(`有 ${materialsFailedCount} 张素材图片准备失败，请重试或移除后再提交`)
      return
    }
    if (countsMismatch) {
      const detail = batchImageIds
        .filter((b) => (config.batchFiles[b.bindingId]?.length ?? 0) > 0)
        .map((b) => `${b.label}: ${config.batchFiles[b.bindingId]!.length}`)
        .join("、")
      toast.error(`多个轮换图片绑定的文件数不一致（${detail}），请对齐`)
      return
    }
    // 必填校验预览
    const missingPreview: string[] = []
    for (const def of selectedTemplate.bindings) {
      if (!def.required) continue
      if (def.type === "text") {
        if (config.textModes[def.bindingId] === "fixed" && !config.fixedTexts[def.bindingId]?.trim()) {
          missingPreview.push(def.label)
        } else if (
          config.textModes[def.bindingId] === "batch" &&
          !csvMapping.has(def.bindingId)
        ) {
          missingPreview.push(`${def.label}（表格列未匹配）`)
        }
      } else {
        if (
          config.imageModes[def.bindingId] === "fixed" &&
          !config.fixedImages[def.bindingId]
        ) {
          missingPreview.push(def.label)
        } else if (config.imageModes[def.bindingId] === "batch") {
          const n = config.batchFiles[def.bindingId]?.length ?? 0
          if (n === 0) missingPreview.push(`${def.label}（未选素材图片）`)
        }
      }
    }
    if (missingPreview.length > 0) {
      toast.error(`必填配置缺失：${missingPreview.join("、")}`)
      return
    }

    const totalCost = taskCount * initialData.costPerRender
    if (initialData.creditsBalance < totalCost) {
      toast.error(`个人配额不足，需要 ${totalCost}，当前 ${initialData.creditsBalance}`)
      return
    }
    if (
      !window.confirm(
        `共 ${taskCount} 张 · ${totalCost} 积分（当前余额 ${initialData.creditsBalance}）\n确认提交批量替换？`,
      )
    ) {
      return
    }

    setSubmitting(true)
    try {
      // 1. 轮换素材（图片库 URL，选图时已上传并预导入外部渲染素材）
      const batchImages: Record<string, string[]> = {}
      for (const b of batchImageIds) {
        const items = config.batchFiles[b.bindingId] ?? []
        if (items.length > 0) batchImages[b.bindingId] = items.map((it) => it.url)
      }

      // 2. 固定绑定值
      const fixed: Record<string, { imageUrl?: string; text?: string }> = {}
      for (const b of imageDefs) {
        if (config.imageModes[b.bindingId] === "fixed") {
          const url = config.fixedImages[b.bindingId]
          if (url) fixed[b.bindingId] = { imageUrl: url }
        }
      }
      for (const b of textDefs) {
        if (config.textModes[b.bindingId] === "fixed") {
          const text = config.fixedTexts[b.bindingId]?.trim()
          if (text) fixed[b.bindingId] = { text }
        }
      }

      // 3. 文字轮换数组（截齐任务数）
      const batchTexts: Record<string, string[]> = {}
      for (const [bid, texts] of Object.entries(batchTextsPreview)) {
        batchTexts[bid] = texts.slice(0, taskCount)
      }

      const res = await submitMockupBatchAction({
        templateId: selectedTemplate.templateId,
        fixed,
        batchImages,
        batchTexts,
        labels: labels.length === taskCount ? labels : undefined,
        outputFormat,
      })
      if (!res.ok || !res.batchId) {
        toast.error(res.error ?? "提交失败")
        return
      }
      toast.success(
        `批次已创建：${res.submitted} 个任务入队，正在后台提交渲染（扣费 ${res.cost} 积分），进度见「生成历史」`,
      )
      for (const f of res.failedSubmits) {
        toast.error(`「${f.displayName}」提交失败：${f.message}`)
      }
      // 提交后切到生成历史（默认来源即批量替换），批次进度实时可见
      setShowHistory(true)
      history.setSource("batch")
      void history.handleRefresh("batch")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  /* ── 未开通空态 ── */
  if (!initialData.available) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 py-8">
        <MockupPageTabs />
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground">
          <Sparkles className="size-10 text-muted-foreground/40" />
          <p>样机渲染服务暂未开通</p>
          <p className="text-xs">请联系平台管理员在超管平台为本企业配置渲染服务</p>
        </div>
      </div>
    )
  }

  const kw = keyword.trim().toLowerCase()
  const publishedTemplates = templates.filter((t) => t.published)
  const visibleTemplates = kw
    ? publishedTemplates.filter(
        (t) =>
          t.name.toLowerCase().includes(kw) ||
          (t.ownerName ?? "").toLowerCase().includes(kw),
      )
    : publishedTemplates

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100svh-7rem)] lg:overflow-hidden">
      {/* 顶栏：页内 Tab + 右侧生成历史入口 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <MockupPageTabs />
        </div>
        <div className="flex items-center gap-2">
          {showHistory ? (
            <>
              <Select
                value={history.source}
                onValueChange={(v) =>
                  v && history.setSource(v as "card" | "batch")
                }
              >
                <SelectTrigger
                  aria-label="切换记录来源"
                  size="sm"
                  className="w-[110px] rounded-[min(var(--radius-md),12px)] text-xs"
                >
                  <SelectValue>
                    {history.source === "card" ? "模板渲染" : "批量替换"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="card">模板渲染</SelectItem>
                  <SelectItem value="batch">批量替换</SelectItem>
                </SelectContent>
              </Select>
              <HistoryDateRangePicker
                value={history.dateRange}
                onChange={history.setDateRange}
                size="sm"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={history.loading}
                onClick={() => void history.handleRefresh()}
              >
                {history.loading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                刷新
              </Button>
            </>
          ) : (
            <>
              <div className="relative w-[220px]">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索模板名称 / 归属人"
                  className="h-7 pl-8 text-xs"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setManageOpen(true)}
              >
                <Settings2 className="size-4" />
                模板管理
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant={showHistory ? "default" : "outline"}
            onClick={() => setShowHistory((v) => !v)}
          >
            <History className="size-4" />
            生成历史
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hide">
        {showHistory ? (
          <MockupHistoryPanel
            source={history.source}
            cards={history.cardRecords}
            batches={history.batchRecords}
            loading={history.loading}
            filterActive={history.filterActive}
          />
        ) : selectedTemplate ? (
            /* ── 第 2 步：配置替换源 ── */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold">
                    批量替换 · {selectedTemplate.name}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {taskCount > 0
                      ? `将生成 ${taskCount} 个渲染任务 · ${taskCount * initialData.costPerRender} 积分`
                      : "选择图片文件夹或上传文字表格开始"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <MockupOutputFormatSelect
                    value={outputFormat}
                    onChange={setOutputFormat}
                  />
                  <Button
                    size="sm"
                    disabled={submitting || taskCount === 0 || materialsPreparing}
                    onClick={() => void handleSubmit()}
                  >
                    {submitting || materialsPreparing ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Play className="size-3.5" />
                    )}
                    {submitting
                      ? "提交中…"
                      : materialsPreparing
                        ? "素材准备中…"
                        : "批量渲染"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void selectTemplate(null)}
                  >
                    <ArrowLeft className="size-3.5" /> 重选模板
                  </Button>
                </div>
              </div>

              {selectedTemplate.bindings.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  该模板没有配置可替换图层，请先在模板管理中编辑绑定
                </div>
              ) : (
                <div className="space-y-2">
                  {/* 图片绑定 */}
                  {imageDefs.map((def) => {
                    const mode = config.imageModes[def.bindingId] ?? "batch"
                    const files = config.batchFiles[def.bindingId] ?? []
                    const isBg = def.role === "background"
                    return (
                      <div
                        key={def.bindingId}
                        className={`rounded-lg border p-3 ${
                          isBg ? "border-primary/40 bg-primary/5" : ""
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                          {/* 左列：标题 + 缩略图/占位框 */}
                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex min-w-0 items-center gap-1.5 text-sm">
                              <ImageIcon className="size-4 text-muted-foreground" />
                              <span className="truncate">{def.label}</span>
                              {isBg ? (
                                <span className="rounded bg-primary/15 px-1 text-[9px] text-primary">
                                  背景
                                </span>
                              ) : null}
                              {def.required ? (
                                <span className="text-destructive">*</span>
                              ) : null}
                              <span className="text-xs text-muted-foreground">
                                图片图层
                              </span>
                              {mode === "batch" && files.length > 0 ? (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  已选 {files.length} 张
                                  {files.some((it) => it.status === "prewarming")
                                    ? " · 准备中…"
                                    : ""}
                                </span>
                              ) : null}
                            </div>
                            {mode === "batch" ? (
                              <>
                                {files.length > 0 ? (
                                  <div className="flex gap-1.5 overflow-x-auto pb-1">
                                    {files.slice(0, 20).map((it) => (
                                      <span
                                        key={it.url}
                                        className="relative size-12 shrink-0 overflow-hidden rounded border bg-muted/50"
                                        title={`${it.name}${
                                          it.status === "failed" && it.error ? `：${it.error}` : ""
                                        }`}
                                      >
                                        <SmartImage
                                          src={toImageSrc(it.url, { width: 96 })}
                                          alt={it.name}
                                          className="size-full object-cover"
                                        />
                                        {it.status !== "ready" ? (
                                          <span
                                            className={`absolute inset-0 flex items-center justify-center bg-background/60 ${
                                              it.status === "failed" ? "text-destructive" : ""
                                            }`}
                                          >
                                            {it.status === "prewarming" ? (
                                              <Loader2 className="size-4 animate-spin" />
                                            ) : (
                                              <AlertCircle className="size-4" />
                                            )}
                                          </span>
                                        ) : null}
                                        {it.status === "failed" ? (
                                          <span className="absolute inset-0 ring-2 ring-inset ring-destructive" />
                                        ) : null}
                                      </span>
                                    ))}
                                    {files.length > 20 ? (
                                      <button
                                        type="button"
                                        title="打开图片库查看全部素材"
                                        onClick={() => setMaterialBinding(def.bindingId)}
                                        className="flex size-12 shrink-0 cursor-pointer items-center justify-center rounded border text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent hover:text-foreground"
                                      >
                                        +{files.length - 20}
                                      </button>
                                    ) : null}
                                  </div>
                                ) : (
                                  <span className="inline-flex size-12 items-center justify-center rounded border border-dashed text-muted-foreground">
                                    <ImageIcon className="size-4" />
                                  </span>
                                )}
                                <p className="text-[10px] text-muted-foreground">
                                  从图片库勾选或上传素材，按勾选顺序轮换，第 i 张图对应第 i 个任务
                                </p>
                              </>
                            ) : config.fixedImages[def.bindingId] ? (
                              <SmartImage
                                src={toImageSrc(config.fixedImages[def.bindingId]!, { width: 96 })}
                                alt="固定图"
                                className="size-12 rounded border object-cover"
                              />
                            ) : (
                              <span className="inline-flex size-12 items-center justify-center rounded border border-dashed text-muted-foreground">
                                <ImageIcon className="size-4" />
                              </span>
                            )}
                          </div>
                          {/* 右列：模式切换 + 操作按钮，彼此水平居中 */}
                          <div className="flex shrink-0 flex-col items-center gap-1.5">
                            <Select
                              value={mode}
                              onValueChange={(v) =>
                                v &&
                                setConfig((prev) => ({
                                  ...prev,
                                  imageModes: {
                                    ...prev.imageModes,
                                    [def.bindingId]: v as "batch" | "fixed",
                                  },
                                }))
                              }
                            >
                              <SelectTrigger size="sm" className="w-[100px] rounded-[min(var(--radius-md),12px)] text-xs">
                                <SelectValue>
                                  {mode === "batch" ? "批量轮换" : "固定图片"}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="batch">批量轮换</SelectItem>
                                <SelectItem value="fixed">固定图片</SelectItem>
                              </SelectContent>
                            </Select>
                            {mode === "batch" ? (
                              <div className="flex flex-wrap items-center justify-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="w-[100px]"
                                  onClick={() => setMaterialBinding(def.bindingId)}
                                >
                                  <ImageIcon className="size-3.5" />
                                  素材图片
                                </Button>
                                {files.some((it) => it.status === "failed") ? (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2 text-xs"
                                      onClick={() => retryPrewarm(def.bindingId)}
                                    >
                                      <RotateCcw className="size-3" /> 重试失败项
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2 text-xs"
                                      onClick={() => removeFailedMaterials(def.bindingId)}
                                    >
                                      <X className="size-3" /> 移除失败项
                                    </Button>
                                  </>
                                ) : null}
                              </div>
                            ) : (
                              <div className="flex flex-wrap items-center justify-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="w-[100px]"
                                  onClick={() => setPickerBinding(def.bindingId)}
                                >
                                  <ImageIcon className="size-3.5" />
                                  素材图片
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}

                  {/* 文字绑定 */}
                  {textDefs.length > 0 ? (
                    <div className="rounded-lg border p-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <FileSpreadsheet className="size-4 text-muted-foreground" />
                          文字替换（{textDefs.length} 个）
                        </span>
                        <div className="flex items-center gap-1.5">
                          <input
                            ref={csvInputRef}
                            type="file"
                            accept=".csv,.tsv,.txt"
                            className="hidden"
                            onChange={(e) => void handleCsvSelected(e.target.files?.[0])}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => csvInputRef.current?.click()}
                          >
                            <FileSpreadsheet className="size-3.5" />
                            {csvName ? "重新上传表格" : "上传 CSV 表格"}
                          </Button>
                        </div>
                      </div>
                      {csvRows ? (
                        <p className="mb-2 text-xs text-muted-foreground">
                          {csvName} · {csvDataRows} 行 · 列头自动匹配：
                          {[...csvMapping.entries()]
                            .map(([bid]) => textDefs.find((d) => d.bindingId === bid)?.label ?? bid)
                            .join("、") || "未匹配到任何文字绑定列"}
                          （列头 = 绑定显示名或 ID，第 i 行对应第 i 张图）
                        </p>
                      ) : (
                        <p className="mb-2 text-xs text-muted-foreground">
                          表格第一行为列头（填写文字绑定的显示名，如
                          「{textDefs[0]?.label ?? "卡名"}」），之后每行对应一张图
                        </p>
                      )}
                      <div className="space-y-2">
                        {textDefs.map((def) => {
                          const mode = config.textModes[def.bindingId] ?? "batch"
                          return (
                            <div
                              key={def.bindingId}
                              className="flex flex-wrap items-center justify-between gap-2"
                            >
                              <span className="flex min-w-0 items-center gap-1.5 text-sm">
                                <span className="truncate">{def.label}</span>
                                {def.required ? (
                                  <span className="text-destructive">*</span>
                                ) : null}
                                {mode === "batch" && csvMapping.has(def.bindingId) ? (
                                  <span className="rounded bg-emerald-500/15 px-1 text-[9px] text-emerald-600">
                                    已匹配列
                                  </span>
                                ) : null}
                              </span>
                              <div className="flex items-center gap-1.5">
                                <Select
                                  value={mode}
                                  onValueChange={(v) =>
                                    v &&
                                    setConfig((prev) => ({
                                      ...prev,
                                      textModes: {
                                        ...prev.textModes,
                                        [def.bindingId]: v as "batch" | "fixed",
                                      },
                                    }))
                                  }
                                >
                                  <SelectTrigger size="sm" className="w-[110px] text-xs">
                                    <SelectValue>
                                      {mode === "batch" ? "表格轮换" : "固定文本"}
                                    </SelectValue>
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="batch">表格轮换</SelectItem>
                                    <SelectItem value="fixed">固定文本</SelectItem>
                                  </SelectContent>
                                </Select>
                                {mode === "fixed" ? (
                                  <Input
                                    value={config.fixedTexts[def.bindingId] ?? ""}
                                    onChange={(e) =>
                                      setConfig((prev) => ({
                                        ...prev,
                                        fixedTexts: {
                                          ...prev.fixedTexts,
                                          [def.bindingId]: e.target.value,
                                        },
                                      }))
                                    }
                                    placeholder={def.required ? "必填文字" : "留空不替换"}
                                    className="h-7 w-[200px] text-xs"
                                  />
                                ) : null}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}

                </div>
              )}
            </div>
          ) : (
            /* ── 第 1 步：选择小模板 ── */
            <div className="space-y-3">
              {detailLoading ? (
                <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" /> 模板加载中…
                </div>
              ) : templatesLoading && templates.length === 0 ? (
                <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
                </div>
              ) : visibleTemplates.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground">
                  <Sparkles className="size-8 text-muted-foreground/40" />
                  {kw
                    ? "没有匹配的小模板"
                    : "暂无已发布的小模板，请先在「模板渲染」页的模板管理中上传 PSD 并发布"}
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-12">
                  {visibleTemplates.map((t) => (
                    <ExternalTemplateCard
                      key={t.templateId}
                      template={t}
                      onToggle={() => void selectTemplate(t.templateId)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
      </div>

      {/* 弹窗组 */}
      <ImageLibraryDialog
        open={pickerBinding !== null}
        onOpenChange={(o) => !o && setPickerBinding(null)}
        assets={designAssets}
        onUploaded={(img) => setDesignAssets((prev) => [img, ...prev])}
        onSelect={(url) => {
          if (!pickerBinding) return
          setConfig((prev) => ({
            ...prev,
            fixedImages: { ...prev.fixedImages, [pickerBinding]: url },
          }))
        }}
      />

      {/* 素材图片（多选，勾选顺序即轮换顺序） */}
      <ImageLibraryDialog
        open={materialBinding !== null}
        onOpenChange={(o) => !o && setMaterialBinding(null)}
        assets={designAssets}
        onUploaded={(img) => setDesignAssets((prev) => [img, ...prev])}
        onSelect={() => {}}
        multiple
        selectedUrls={
          materialBinding
            ? (config.batchFiles[materialBinding] ?? []).map((it) => it.url)
            : []
        }
        onSelectMany={(images) => {
          if (materialBinding) handleSelectMaterials(materialBinding, images)
        }}
      />

      <TemplateManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        currentUserId={currentUserId}
        isAdmin={isAdmin}
        onChanged={() => {
          void loadTemplates()
          router.refresh()
        }}
      />
    </div>
  )
}
