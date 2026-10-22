"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { ChevronRight, ImagePlus, Loader2, Search, SearchX, Trash2 } from "lucide-react"
import {
  createPublishTemplateAction,
  getTemuAttrTemplateAction,
  listTemuParentSpecsAction,
  searchTemuCategoriesAction,
  updatePublishTemplateAction,
  uploadPublishImageAction,
  checkTemuDimensionImageAction,
  type TemuAttrTemplate,
  type TemuCategoryNode,
  type TemuParentSpec,
  type TemuPublishTemplateRow,
} from "@/server/actions/temu-publish"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Combobox } from "@/components/ui/combobox"
import { ImageLibraryDialog } from "@/components/mockup/image-library-dialog"
import { listMockupDesignAssetsAction } from "@/server/actions/mockup"
import type { MockupLibraryImage } from "@/lib/mockup/types"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { ImageUploadField } from "./image-upload-field"

/** 包装/工艺/SKU 分类枚举（包装值域 2026-10-20 实测；官方未公开名称） */
const PACKAGE_SHAPE_OPTIONS = [
  { value: "1", label: "长方体" },
  { value: "2", label: "圆柱体" },
]
const PACKAGE_TYPE_OPTIONS = [
  { value: "0", label: "硬包装" },
  { value: "1", label: "软包装+硬物" },
  { value: "2", label: "软包装+软物" },
]
/** 定制一级工艺（docs §13.6） */
const FIRST_TYPE_OPTIONS = [
  { value: "10001", label: "基础工艺" },
  { value: "10002", label: "木制品" },
  { value: "10003", label: "金属制品" },
  { value: "10004", label: "皮具/布艺" },
  { value: "10005", label: "有机材料（亚克力/树脂）" },
  { value: "10006", label: "画布/纸张" },
]
const SKU_CLASS_OPTIONS = [
  { value: "1", label: "单品" },
  { value: "2", label: "组合" },
  { value: "3", label: "混套装" },
]
const PIECE_UNIT_OPTIONS = [
  { value: "1", label: "件" },
  { value: "2", label: "双" },
  { value: "3", label: "包" },
]

/** 中国省份 region2Id 枚举（官方 §13.1；仅到省级，无市级字段） */
const PROVINCE_OPTIONS: Array<{ value: string; label: string }> = [
  "北京市", "安徽省", "福建省", "甘肃省", "广东省", "广西壮族自治区", "贵州省", "海南省",
  "河北省", "河南省", "黑龙江省", "湖北省", "湖南省", "吉林省", "江苏省", "江西省",
  "辽宁省", "内蒙古自治区", "宁夏回族自治区", "青海省", "山东省", "山西省", "陕西省",
  "上海市", "四川省", "天津市", "西藏自治区", "新疆维吾尔自治区", "云南省", "浙江省", "重庆市",
].map((name, i) => ({ value: String(43000000000002 + i), label: name }))

/** 常用产地二字码（productOrigin.countryShortName） */
const COUNTRY_OPTIONS = ["CN", "US", "DE", "IT", "TR", "VN", "IN"].map((c) => ({
  value: c,
  label: c,
}))

/**
 * 刊登模板向导（4 步）：类目（关键词 match + 树钻取）→ 属性与规格（attrs.get 驱动、
 * 父子联动选值 + spec 自建定义）→ 素材与默认值（官方图床上传/牛皮癣/价格重量体积敏感）
 * → 预览保存。锁定层在此定死，发品时仅可覆盖标题/图/申报价/货号。
 */
export function TemplateWizard({
  open,
  editing,
  onOpenChange,
}: {
  open: boolean
  editing: TemuPublishTemplateRow | null
  onOpenChange: (v: boolean) => void
}) {
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)

  // Step1 类目
  const [keyword, setKeyword] = useState("")
  const [searching, setSearching] = useState(false)
  /** 关键词匹配到的完整类目链（cat1..leaf，必须整链使用防 6000011） */
  const [matched, setMatched] = useState<TemuCategoryNode[][]>([])
  const [children, setChildren] = useState<TemuCategoryNode[]>([])
  const [childrenLoading, setChildrenLoading] = useState(false)
  const [chain, setChain] = useState<TemuCategoryNode[]>([])

  // Step2 属性 + 规格
  const [attrTpl, setAttrTpl] = useState<TemuAttrTemplate | null>(null)
  const [attrLoading, setAttrLoading] = useState(false)
  const [attrError, setAttrError] = useState("")
  /** templatePid → 选中值（vid/value），父子联动过滤 */
  const [selected, setSelected] = useState<Record<number, { vid: number; value: string }>>({})
  /** 数值/文本输入型属性（无候选值）：templatePid → 输入串 */
  const [typed, setTyped] = useState<Record<number, string>>({})
  const [parentSpecs, setParentSpecs] = useState<TemuParentSpec[]>([])
  const [specParentId, setSpecParentId] = useState<number | null>(null)
  const [specName, setSpecName] = useState("")

  // Step3 默认层
  const [name, setName] = useState("")
  const [title, setTitle] = useState("")
  /** 素材图源（http URL 或压缩 dataUrl；发品时按目标店上传） */
  const [images, setImages] = useState<string[]>([])
  /** 尺寸图源（可选；发品时按目标店上传后固定插轮播第 2 张） */
  const [dimensionImage, setDimensionImage] = useState<string | null>(null)
  /** 尺寸图官方校验进行中 */
  const [dimChecking, setDimChecking] = useState(false)
  const [priceYuan, setPriceYuan] = useState("")
  const [extCode, setExtCode] = useState("")
  const [country, setCountry] = useState("CN")
  const [region2Id, setRegion2Id] = useState<number | null>(null)
  const [weightG, setWeightG] = useState("")
  const [lenCm, setLenCm] = useState("")
  const [widthCm, setWidthCm] = useState("")
  const [heightCm, setHeightCm] = useState("")
  const [sensitive, setSensitive] = useState(false)
  const [batteryWh, setBatteryWh] = useState("")
  // 包装 / 说明书 / 定制 / SKU 分类（均可选；null/关闭=不提交该块）
  const [pkgShape, setPkgShape] = useState<string | null>(null)
  const [pkgType, setPkgType] = useState<string | null>(null)
  /** 外包装三图（正拍/侧拍/俯拍，temu 图床 URL；三张齐才随发品提交） */
  const [pkgImages, setPkgImages] = useState<Array<string | null>>([null, null, null])
  const [guideFile, setGuideFile] = useState<{ fileName: string } | null>(null)
  /** PDF 源（发品时按目标店重传；编辑回填不带、更新时服务端沿用库内源） */
  const [guideB64, setGuideB64] = useState<string | null>(null)
  const [guideUploading, setGuideUploading] = useState(false)
  const [customEnabled, setCustomEnabled] = useState(false)
  const [customFirst, setCustomFirst] = useState<string | null>(null)
  const [customTwice, setCustomTwice] = useState("")
  const [skuClass, setSkuClass] = useState("1")
  const [skuPieces, setSkuPieces] = useState("1")
  const [skuUnit, setSkuUnit] = useState("1")

  // 编辑模式回填
  useEffect(() => {
    if (!open || !editing) return
    setStep(1)
    setChain(editing.categoryChain)
    // 属性回填（templatePid 是否过期由进入第 2 步重拉模板核对）
    setSelected(
      Object.fromEntries(
        editing.attributes
          .filter((a) => a.vid > 0)
          .map((a) => [a.templatePid, { vid: a.vid, value: a.propValue }]),
      ),
    )
    setTyped(
      Object.fromEntries(
        editing.attributes
          .filter((a) => a.numberInputValue)
          .map((a) => [a.templatePid, a.numberInputValue!]),
      ),
    )
    const d = editing.defaults
    setName(editing.name)
    setTitle(d.title)
    setImages(d.imageUrls)
    setPriceYuan((d.declaredPriceFen / 100).toString())
    setExtCode(d.extCode ?? "")
    setCountry(d.countryShortName)
    setRegion2Id(d.region2Id ?? null)
    setWeightG((d.weightMg / 1000).toString())
    setLenCm((d.volumeMm.len / 10).toString())
    setWidthCm((d.volumeMm.width / 10).toString())
    setHeightCm((d.volumeMm.height / 10).toString())
    setSensitive(d.isSensitive === 1)
    setBatteryWh(d.maxBatteryCapacityWh ? String(d.maxBatteryCapacityWh) : "")
    setPkgShape(d.outerPackage?.packageShape ? String(d.outerPackage.packageShape) : null)
    setPkgType(d.outerPackage ? String(d.outerPackage.packageType) : null)
    setPkgImages([
      d.outerPackageImages?.[0] ?? null,
      d.outerPackageImages?.[1] ?? null,
      d.outerPackageImages?.[2] ?? null,
    ])
    setDimensionImage(d.dimensionImageUrl ?? null)
    setGuideFile(d.guideFile ? { fileName: d.guideFile.fileName } : null)
    setGuideB64(null)
    setCustomEnabled(Boolean(d.customized))
    setCustomFirst(d.customized ? String(d.customized.firstType) : null)
    setCustomTwice(d.customized ? d.customized.twiceType.join(",") : "")
    setSkuClass(d.skuPack ? String(d.skuPack.skuClassification) : "1")
    setSkuPieces(d.skuPack ? String(d.skuPack.numberOfPieces) : "1")
    setSkuUnit(d.skuPack ? String(d.skuPack.pieceUnitCode) : "1")
    setSpecParentId(editing.specConfig.parentSpecId)
    setSpecName(editing.specConfig.specName)
  }, [open, editing])

  // 根类目 / 钻取子级
  const loadChildren = useCallback(async (parentCatId: number) => {
    setChildrenLoading(true)
    const r = await searchTemuCategoriesAction({ parentCatId })
    if (r.ok) setChildren(r.rows)
    else toast.error(r.error)
    setChildrenLoading(false)
  }, [])

  useEffect(() => {
    if (open && chain.length === 0) void loadChildren(0)
  }, [open, chain.length, loadChildren])

  const pickNode = (node: TemuCategoryNode) => {
    if (node.isLeaf) {
      setChain((prev) => [...prev.slice(0, -1), node])
    } else {
      setChain((prev) => [...prev, node])
      void loadChildren(node.catId)
    }
  }

  const resetToLevel = (level: number) => {
    setChain((prev) => prev.slice(0, level))
    void loadChildren(level === 0 ? 0 : chain[level - 1]!.catId)
  }

  /** 尺寸图官方校验（参考性，不拦截发品）：源图先按素材口径传官方图床，再走两段式校验 */
  const checkDimension = async () => {
    if (!dimensionImage) return
    setDimChecking(true)
    try {
      let url = dimensionImage
      if (!url.includes("img.kwcdn.com")) {
        // 校验只认官方图床 URL：先上传（显式用户操作——保存模板本身零 TEMU 调用的口径不变）
        const up = url.startsWith("data:")
          ? await uploadPublishImageAction({ imageDataUrl: url, kind: "material" })
          : await uploadPublishImageAction({ imageUrl: url, kind: "material" })
        if (!up.ok) {
          toast.error(`尺寸图上传失败：${up.error}`, { duration: 6000 })
          return
        }
        url = up.image.temuUrl
      }
      const r = await checkTemuDimensionImageAction({ imageUrl: url })
      if (!r.ok) {
        toast.error(r.error, { duration: 6000 })
        return
      }
      if (r.result.status === "processing") {
        toast.info("官方识别中，请稍后再点校验")
        return
      }
      toast(`尺寸图校验结论：${r.result.message}${r.result.imageType != null ? `（imageType=${r.result.imageType}）` : ""}`, {
        duration: 8000,
      })
    } finally {
      setDimChecking(false)
    }
  }

  const doSearch = async () => {
    if (!keyword.trim()) return
    setSearching(true)
    const r = await searchTemuCategoriesAction({ keyword: keyword.trim() })
    if (r.ok) {
      setMatched(r.chains ?? [])
      if ((r.chains ?? []).length === 0) toast.info("无匹配叶子类目，换关键词或用逐级钻取")
    } else toast.error(r.error)
    setSearching(false)
  }

  // Step2 进入时拉属性模板 + 父规格
  useEffect(() => {
    if (step !== 2 || chain.length === 0) return
    const leaf = chain[chain.length - 1]!
    void (async () => {
      setAttrLoading(true)
      setAttrError("")
      const [tpl, specs] = await Promise.all([
        getTemuAttrTemplateAction({ catId: leaf.catId }),
        listTemuParentSpecsAction(),
      ])
      if (tpl.ok) setAttrTpl(tpl.template)
      else setAttrError(tpl.error)
      if (specs.ok) {
        setParentSpecs(specs.rows)
        setSpecParentId((prev) => prev ?? specs.rows.find((s) => s.parentSpecName === "颜色")?.parentSpecId ?? specs.rows[0]?.parentSpecId ?? null)
      }
      setAttrLoading(false)
    })()
  }, [step, chain])

  /** 普通必填属性（非销售规格），按模板顺序 */
  const requiredProps = useMemo(
    () => (attrTpl?.properties ?? []).filter((p) => p.required && !p.isSale),
    [attrTpl],
  )

  /** 候选值按父子联动过滤：父属性已选时仅保留 parentVidList 含父 vid（或无约束）的值 */
  const valuesFor = (p: (typeof requiredProps)[number]) => {
    if (!p.parentTemplatePid) return p.values
    const parentSel = selected[p.parentTemplatePid]
    if (!parentSel) return p.values
    return p.values.filter((v) => v.parentVidList.length === 0 || v.parentVidList.includes(parentSel.vid))
  }

  const step2Valid =
    requiredProps.every((p) =>
      p.values.length > 0 ? selected[p.templatePid] != null : (typed[p.templatePid] ?? "").trim() !== "",
    ) && specParentId != null && specName.trim().length > 0

  const fen = Math.round(Number(priceYuan) * 100)
  const step3Valid =
    name.trim().length > 0 &&
    title.trim().length > 0 &&
    Number.isFinite(fen) &&
    fen > 0 &&
    weightG !== "" &&
    Number(weightG) > 0 &&
    lenCm !== "" && widthCm !== "" && heightCm !== "" &&
    Number(lenCm) >= Number(widthCm) &&
    Number(widthCm) >= Number(heightCm) &&
    (!sensitive || batteryWh !== "") &&
    (country !== "CN" || region2Id != null) &&
    // 定制开关开启时一级/二级工艺必填（与界面 * 标注对齐，避免静默按非定制保存）
    (!customEnabled || (customFirst != null && customTwice.trim().length > 0))

  const buildPayload = () => {
    const attributes = requiredProps.map((p) => {
      const sel = selected[p.templatePid]
      const typedVal = typed[p.templatePid]?.trim()
      return {
        templatePid: p.templatePid,
        pid: p.pid,
        refPid: p.refPid,
        propName: p.name,
        vid: sel?.vid ?? 0,
        propValue: sel?.value ?? typedVal ?? "",
        valueUnit: "",
        ...(p.values.length === 0 && typedVal ? { numberInputValue: typedVal } : {}),
      }
    })
    const parent = parentSpecs.find((s) => s.parentSpecId === specParentId)
    return {
      name: name.trim(),
      categoryChain: chain,
      attributes,
      specConfig: {
        parentSpecId: specParentId!,
        parentSpecName: parent?.parentSpecName ?? "",
        specName: specName.trim(),
      },
      defaults: {
        title: title.trim(),
        imageUrls: images,
        declaredPriceFen: fen,
        extCode: extCode.trim(),
        countryShortName: country,
        ...(country === "CN" && region2Id ? { region2Id } : {}),
        weightMg: Math.round(Number(weightG) * 1000),
        volumeMm: {
          len: Math.round(Number(lenCm) * 10),
          width: Math.round(Number(widthCm) * 10),
          height: Math.round(Number(heightCm) * 10),
        },
        isSensitive: sensitive ? (1 as const) : (0 as const),
        sensitiveTypes: sensitive ? [110001] : [],
        ...(sensitive && batteryWh ? { maxBatteryCapacityWh: Number(batteryWh) } : {}),
        ...(pkgType
          ? {
              outerPackage: {
                ...(pkgShape ? { packageShape: Number(pkgShape) as 1 | 2 } : {}),
                packageType: Number(pkgType) as 0 | 1 | 2,
              },
            }
          : {}),
        ...(pkgImages.some(Boolean)
          ? { outerPackageImages: pkgImages.filter((x): x is string => Boolean(x)) }
          : {}),
        ...(dimensionImage ? { dimensionImageUrl: dimensionImage } : {}),
        ...(guideFile
          ? {
              guideFile: {
                fileName: guideFile.fileName,
                languages: ["en"],
                ...(guideB64 ? { base64: guideB64 } : {}),
              },
            }
          : {}),
        ...(customEnabled && customFirst && customTwice.trim()
          ? {
              customized: {
                firstType: Number(customFirst),
                twiceType: customTwice.split(/[,，\s]+/).map(Number).filter((n) => n >= 20001 && n <= 20040),
                technologyType: 1,
              },
            }
          : {}),
        ...(skuClass !== "1" || skuPieces !== "1" || skuUnit !== "1"
          ? {
              skuPack: {
                skuClassification: Number(skuClass) as 1 | 2 | 3,
                numberOfPieces: Number(skuPieces) || 1,
                pieceUnitCode: Number(skuUnit) as 1 | 2 | 3,
              },
            }
          : {}),
      },
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const payload = buildPayload()
      const r = editing
        ? await updatePublishTemplateAction({ id: editing.id, ...payload })
        : await createPublishTemplateAction(payload)
      if (r.ok) {
        toast.success(editing ? "模板已更新" : "模板已创建")
        onOpenChange(false)
      } else toast.error(r.error)
    } catch {
      // server action promise reject（请求体超 20mb 被拒 / 网络错）时兜底提示，避免静默失败
      toast.error("保存失败：请求过大或网络错误，请重试")
    } finally {
      setSaving(false)
    }
  }

  const chainNames = chain.map((c) => c.catName).join(" / ")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? "编辑刊登模板" : "新建刊登模板"}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              第 {step}/4 步 ·{" "}
              {["选择类目", "属性与规格", "素材与默认值", "预览保存"][step - 1]}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-80 space-y-4">
          {step === 1 && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input
                  placeholder="关键词搜索叶子类目（如：收纳架、鸟笼、台灯）"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void doSearch()}
                />
                <Button onClick={() => void doSearch()} disabled={searching}>
                  {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                  搜索
                </Button>
              </div>
              {matched.length > 0 && (
                <div className="grid max-h-48 grid-cols-1 gap-1.5 overflow-y-auto">
                  {matched.map((m) => {
                    const leaf = m[m.length - 1]!
                    const selected = chain[chain.length - 1]?.catId === leaf.catId
                    return (
                      <button
                        type="button"
                        key={leaf.catId}
                        className={cn(
                          "rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent",
                          selected && "border-primary bg-primary/10",
                        )}
                        onClick={() => {
                          setMatched([])
                          setChain(m)
                        }}
                      >
                        {m.map((c, i) => (
                          <span key={c.catId}>
                            {i > 0 && <span className="mx-0.5 text-muted-foreground">/</span>}
                            <span className={c.isLeaf ? "font-medium text-emerald-600 dark:text-emerald-400" : ""}>
                              {c.catName}
                            </span>
                          </span>
                        ))}
                      </button>
                    )
                  })}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1 text-sm">
                <button type="button" className="rounded px-1.5 py-0.5 hover:bg-accent" onClick={() => resetToLevel(0)}>
                  全部类目
                </button>
                {chain.map((c, i) => (
                  <span key={c.catId} className="flex items-center gap-1">
                    <ChevronRight className="size-3 text-muted-foreground" />
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 hover:bg-accent"
                      onClick={() => void resetToLevel(i + 1)}
                    >
                      {c.catName}
                    </button>
                  </span>
                ))}
              </div>
              <div className="grid max-h-64 grid-cols-2 gap-1.5 overflow-y-auto sm:grid-cols-3">
                {childrenLoading ? (
                  <div className="col-span-full flex items-center justify-center py-6 text-sm text-muted-foreground">
                    <Loader2 className="mr-2 size-4 animate-spin" /> 加载子类目…
                  </div>
                ) : (
                  children.map((c) => (
                    <button
                      type="button"
                      key={c.catId}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent",
                        chain[chain.length - 1]?.catId === c.catId && "border-primary bg-primary/10",
                        // 叶子类目绿色文字提示（可直接选定）
                        c.isLeaf && "font-medium text-emerald-600 dark:text-emerald-400",
                      )}
                      onClick={() => pickNode(c)}
                    >
                      {c.catName}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">类目：{chainNames}</p>
              {attrLoading ? (
                <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" /> 拉取官方属性模板…
                </div>
              ) : attrError ? (
                <p className="text-sm text-destructive">{attrError}</p>
              ) : (
                <>
                  {requiredProps.length === 0 && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <SearchX className="size-4" /> 该类目无必填属性。
                    </p>
                  )}
                  <div className="grid max-h-64 grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
                    {requiredProps.map((p) => (
                      <div key={p.templatePid} className="space-y-1.5">
                        <Label className="text-xs">
                          {p.name}
                          <span className="text-destructive">*</span>
                          {p.parentTemplatePid > 0 && (
                            <span className="ml-1 text-muted-foreground">（随父属性联动）</span>
                          )}
                        </Label>
                        {p.values.length > 0 ? (
                          <Combobox
                            value={selected[p.templatePid] ? String(selected[p.templatePid]!.vid) : null}
                            onChange={(v) => {
                              const val = p.values.find((x) => String(x.vid) === v)
                              if (val)
                                setSelected((prev) => {
                                  const next = { ...prev, [p.templatePid]: { vid: val.vid, value: val.value } }
                                  // 父属性改选后旧子属性值对新父 vid 可能非法（下拉只过滤
                                  // options 不清 state），一并清除让用户重选
                                  for (const child of requiredProps) {
                                    if (child.parentTemplatePid === p.templatePid) delete next[child.templatePid]
                                  }
                                  return next
                                })
                            }}
                            options={valuesFor(p).map((v) => ({ value: String(v.vid), label: v.value }))}
                            placeholder={`选择${p.name}`}
                            searchPlaceholder={`搜索${p.name}…`}
                            className="w-full"
                          />
                        ) : (
                          <Input
                            placeholder={`输入${p.name}`}
                            value={typed[p.templatePid] ?? ""}
                            onChange={(e) => setTyped((prev) => ({ ...prev, [p.templatePid]: e.target.value }))}
                          />
                        )}
                      </div>
                    ))}
                    <div className="space-y-1.5">
                      <Label className="text-xs">规格父级（决定 SKU 维度）</Label>
                      <Combobox
                        value={specParentId ? String(specParentId) : null}
                        onChange={(v) => setSpecParentId(Number(v))}
                        options={parentSpecs.map((x) => ({ value: String(x.parentSpecId), label: x.parentSpecName }))}
                        placeholder="选择父规格"
                        searchPlaceholder="搜索父规格…"
                        className="w-full"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        规格值名<span className="text-destructive">*</span>
                      </Label>
                      <Input
                        placeholder="如：藏青 / 黑色 / 标准款"
                        value={specName}
                        onChange={(e) => setSpecName(e.target.value)}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        非服饰类目无内置规格，发品时自动在店铺规格库创建（同名复用）。
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="grid max-h-105 gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">模板名 *</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：宠物用品-鸟笼-标准款" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">商品名（发品时可覆盖）*</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">素材图（发品时必须 ≥5 张，可不配置）</Label>
                <ImageUploadField images={images} onChange={setImages} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">尺寸图（可选，固定轮播第 2 张）</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground hover:text-foreground"
                    disabled={!dimensionImage || dimChecking}
                    onClick={() => void checkDimension()}
                  >
                    {dimChecking ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    官方校验
                  </Button>
                </div>
                <ImageUploadField
                  images={dimensionImage ? [dimensionImage] : []}
                  onChange={(next) => setDimensionImage(next[next.length - 1] ?? null)}
                  max={1}
                  hint="卖家中心口径尺寸图放轮播第 2 张（API 实测不校验位置）；随素材一起按目标店铺上传。「官方校验」为参考性结论，不拦截发品。"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">申报价（元，SKU 同价）*</Label>
                <Input type="number" min="0.01" step="0.01" value={priceYuan} onChange={(e) => setPriceYuan(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">货号（可空）</Label>
                <Input value={extCode} onChange={(e) => setExtCode(e.target.value)} placeholder="字母/数字/标点" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">产地 *</Label>
                <Combobox
                  value={country}
                  onChange={(v) => {
                    setCountry(v)
                    if (v !== "CN") setRegion2Id(null)
                  }}
                  options={COUNTRY_OPTIONS}
                  placeholder="选择产地"
                  searchPlaceholder="搜索产地…"
                  className="w-full"
                />
              </div>
              {country === "CN" && (
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    省份<span className="text-destructive">*</span>
                    <span className="ml-1 font-normal text-muted-foreground">（中国产地官方必填）</span>
                  </Label>
                  <Combobox
                    value={region2Id ? String(region2Id) : null}
                    onChange={(v) => setRegion2Id(v ? Number(v) : null)}
                    options={PROVINCE_OPTIONS}
                    placeholder="选择省份"
                    searchPlaceholder="搜索省份…"
                    className="w-full"
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">SKU 重量（克）*</Label>
                <Input type="number" min="0.1" step="0.1" value={weightG} onChange={(e) => setWeightG(e.target.value)} />
              </div>
              <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">长（cm）*</Label>
                  <Input type="number" min="0.1" step="0.1" value={lenCm} onChange={(e) => setLenCm(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">宽（cm）*（次长边）</Label>
                  <Input type="number" min="0.1" step="0.1" value={widthCm} onChange={(e) => setWidthCm(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">高（cm）*（最短边）</Label>
                  <Input type="number" min="0.1" step="0.1" value={heightCm} onChange={(e) => setHeightCm(e.target.value)} />
                </div>
                <p className="col-span-3 text-[11px] text-muted-foreground">官方口径：最长边 ≥ 次长边 ≥ 最短边。</p>
              </div>
              <div className="flex items-center gap-3 sm:col-span-2">
                <Switch checked={sensitive} onCheckedChange={setSensitive} />
                <Label className="text-xs">敏感商品（含电池/液体等；纯电需填储电容量）</Label>
              </div>
              {sensitive && (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label className="text-xs">敏感类型与储电容量</Label>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <BadgeLike>纯电（110001）</BadgeLike>
                    <Input
                      className="h-8 w-40"
                      type="number"
                      min="1"
                      placeholder="储电容量上限 Wh"
                      value={batteryWh}
                      onChange={(e) => setBatteryWh(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 sm:col-span-2">
                <span className="text-xs font-medium text-muted-foreground">外包装信息（可选）</span>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">外包装形状</Label>
                <Combobox
                  value={pkgShape}
                  onChange={(v) => setPkgShape(v || null)}
                  options={PACKAGE_SHAPE_OPTIONS}
                  placeholder="长方体 / 圆柱体（其他不规则可不选）"
                  searchPlaceholder="搜索形状…"
                  className="w-full"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">外包装类型</Label>
                <Combobox
                  value={pkgType}
                  onChange={(v) => setPkgType(v || null)}
                  options={PACKAGE_TYPE_OPTIONS}
                  placeholder="选择类型"
                  searchPlaceholder="搜索类型…"
                  className="w-full"
                />
              </div>
              <p className="text-[11px] text-muted-foreground sm:col-span-2">
                官方未公开形状/类型名称，值为实测合法值域（形状 1-2 / 类型 0-2），与卖家中心选项对照后选择。
              </p>

              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">外包装图片（正拍 / 侧拍 / 俯拍）</Label>
                <PackagingImageSlots images={pkgImages} onChange={setPkgImages} />
                <p className="text-[11px] text-muted-foreground">
                  官方建议 正拍/侧拍/俯拍 三视角（1-6 张）；发品时按目标店铺自动上传官方包装图库并随发品提交。
                </p>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label className="text-xs">电子说明书（可选，PDF）</Label>
                {guideFile ? (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="truncate rounded border bg-muted px-2 py-1">{guideFile.fileName}</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setGuideFile(null)}>
                      移除
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      id="temu-guide-pdf"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        e.target.value = ""
                        if (!file) return
                        // 与服务端口径对齐：schemas/temu.ts guideFile.base64 为
                        // z.string().max(20_000_000)，base64 长度 = 4·ceil(size/3)，
                        // 精确上限 15_000_000 字节；取 14_500_000 给 JSON 其余字段
                        // （素材图 dataUrl 等）与 multipart 开销留余量，避免走完
                        // 4 步后才被 zod/20mb 请求体上限拒绝
                        if (file.size > 14_500_000) {
                          toast.error("PDF 超过 14.5MB（服务端 base64 上限换算，请压缩后重试）")
                          return
                        }
                        void (async () => {
                          setGuideUploading(true)
                          try {
                            const b64 = await new Promise<string>((resolve, reject) => {
                              const fr = new FileReader()
                              fr.onload = () => {
                                const dataUrl = String(fr.result)
                                resolve(dataUrl.slice(dataUrl.indexOf(",") + 1))
                              }
                              fr.onerror = () => reject(new Error("读取文件失败"))
                              fr.readAsDataURL(file)
                            })
                            setGuideFile({ fileName: file.name })
                            setGuideB64(b64)
                            toast.success("说明书已就绪（发品时按目标店铺自动上传）")
                          } finally {
                            setGuideUploading(false)
                          }
                        })()
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={guideUploading}
                      onClick={() => document.getElementById("temu-guide-pdf")?.click()}
                    >
                      {guideUploading ? <Loader2 className="size-4 animate-spin" /> : null}
                      选择 PDF
                    </Button>
                    <span className="text-[11px] text-muted-foreground">类目必填时必须上传（2000148）；须包含英文内容（2000163）；PDF 源存模板、发品时按目标店铺上传（保存不请求 TEMU）</span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3 sm:col-span-2">
                <Switch checked={customEnabled} onCheckedChange={setCustomEnabled} />
                <Label className="text-xs">定制商品（开启后提交定制工艺）</Label>
              </div>
              {customEnabled && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">一级工艺 *</Label>
                    <Combobox
                      value={customFirst}
                      onChange={(v) => setCustomFirst(v || null)}
                      options={FIRST_TYPE_OPTIONS}
                      placeholder="选择一级工艺"
                      searchPlaceholder="搜索工艺…"
                      className="w-full"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">二级工艺 id *</Label>
                    <Input
                      placeholder="如 20001（激光雕刻-文字），多个逗号分隔，范围 20001-20040"
                      value={customTwice}
                      onChange={(e) => setCustomTwice(e.target.value)}
                    />
                  </div>
                </>
              )}

              <div className="flex items-center gap-3 sm:col-span-2">
                <span className="text-xs font-medium text-muted-foreground">SKU 分类 / 多件装（默认单品 1 件）</span>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">SKU 分类</Label>
                <Combobox
                  value={skuClass}
                  onChange={setSkuClass}
                  options={SKU_CLASS_OPTIONS}
                  placeholder="单品"
                  searchPlaceholder="搜索…"
                  className="w-full"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">件数</Label>
                  <Input type="number" min="1" max="999" value={skuPieces} onChange={(e) => setSkuPieces(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">单位</Label>
                  <Combobox
                    value={skuUnit}
                    onChange={setSkuUnit}
                    options={PIECE_UNIT_OPTIONS}
                    placeholder="件"
                    searchPlaceholder="搜索…"
                    className="w-full"
                  />
                </div>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="max-h-105 space-y-2 overflow-y-auto pr-1 text-sm">
              <Summary label="模板名" value={name} />
              <Summary label="类目链" value={chainNames} />
              <Summary
                label="必填属性"
                value={
                  requiredProps
                    .map((p) => `${p.name}=${selected[p.templatePid]?.value ?? typed[p.templatePid] ?? "—"}`)
                    .join("；") || "无"
                }
              />
              <Summary
                label="规格"
                value={`${parentSpecs.find((s) => s.parentSpecId === specParentId)?.parentSpecName ?? ""}：${specName}`}
              />
              <Summary label="商品名" value={title} />
              <Summary label="素材图" value={`${images.length} 张（1:1 ≥800、最少 5 张）`} />
              <Summary label="申报价" value={`¥${(fen / 100).toFixed(2)}`} />
              <Summary label="货号" value={extCode || "（空）"} />
              <Summary
                label="重量/体积"
                value={`${weightG}g · ${lenCm}×${widthCm}×${heightCm}cm`}
              />
              <Summary
                label="产地"
                value={
                  country +
                  (country === "CN" && region2Id
                    ? ` · ${PROVINCE_OPTIONS.find((x) => x.value === String(region2Id))?.label ?? ""}`
                    : "")
                }
              />
              <Summary
                label="敏感"
                value={sensitive ? `纯电（≤${batteryWh || "?"}Wh）` : "非敏感"}
              />
              <Summary
                label="外包装"
                value={
                  pkgType
                    ? `${pkgShape ? PACKAGE_SHAPE_OPTIONS.find((x) => x.value === pkgShape)?.label + " / " : ""}${PACKAGE_TYPE_OPTIONS.find((x) => x.value === pkgType)?.label}${pkgImages.filter(Boolean).length === 3 ? ` / 三图已配` : ""}`
                    : "不提交"
                }
              />
              <Summary label="说明书" value={guideFile ? guideFile.fileName : "无"} />
              <Summary
                label="定制"
                value={
                  customEnabled && customFirst
                    ? `${FIRST_TYPE_OPTIONS.find((x) => x.value === customFirst)?.label} / ${customTwice}`
                    : "非定制"
                }
              />
              <Summary
                label="SKU 分类"
                value={`${SKU_CLASS_OPTIONS.find((x) => x.value === skuClass)?.label} · ${skuPieces}${PIECE_UNIT_OPTIONS.find((x) => x.value === skuUnit)?.label}`}
              />
              <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                注意：部分类目官方强制「外包装照片」，当前官方 API 暂无该图上传通路（待工单确认）——
                若发品被拒，错误原因会原样展示在发品记录里。
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          {step > 1 && (
            <Button variant="outline" size="sm" onClick={() => setStep(step - 1)}>
              上一步
            </Button>
          )}
          {step < 4 ? (
            <Button
              size="sm"
              disabled={
                (step === 1 && !(chain.length > 0 && chain[chain.length - 1]!.isLeaf)) ||
                // 模板未拉到/拉取失败时禁止放行：空 requiredProps 会让 step2Valid 恒真，
                // 保存将清空编辑模板已存 attributes（需区分「类目本无必填属性」——attrTpl
                // 拉取成功且为空才允许通过）
                (step === 2 && (attrLoading || attrError !== "" || attrTpl == null)) ||
                (step === 2 && !step2Valid) ||
                (step === 3 && !step3Valid)
              }
              onClick={() => setStep(step + 1)}
            >
              下一步
            </Button>
          ) : (
            <Button size="sm" disabled={saving || !step3Valid} onClick={() => void save()}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {editing ? "保存修改" : "创建模板"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b pb-1.5">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-sm">{value}</span>
    </div>
  )
}

function BadgeLike({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border bg-muted px-1.5 py-0.5 text-[11px]">{children}</span>
  )
}

/** 外包装三视角图槽位（正拍/侧拍/俯拍）：每槽独立选图，package 口径上传（不限 1:1） */
function PackagingImageSlots({
  images,
  onChange,
}: {
  images: Array<string | null>
  onChange: (next: Array<string | null>) => void
}) {
  const [picking, setPicking] = useState<number | null>(null)
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null)
  const [assets, setAssets] = useState<MockupLibraryImage[]>([])
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (picking == null || assets.length > 0) return
    void (async () => {
      const res = await listMockupDesignAssetsAction()
      setAssets(res.images ?? [])
    })()
  }, [picking, assets.length])

  /** 本地校验（≤2M、JPG/PNG）后存源 URL——包装图在发品时按目标店上传 */
  const pick = async (idx: number, url: string) => {
    setPicking(null)
    setUploadingIdx(idx)
    setUploading(true)
    try {
      const res = await fetch(`/api/image/proxy?url=${encodeURIComponent(url)}`)
      if (res.ok) {
        const blob = await res.blob()
        if (blob.size > 2 * 1024 * 1024) {
          toast.error("包装图超过 2M（官方 2000021），请压缩后重选")
          return
        }
        if (!["image/jpeg", "image/png"].includes(blob.type)) {
          toast.error("包装图仅支持 JPG/PNG")
          return
        }
      }
      const next = [...images]
      next[idx] = url
      onChange(next)
    } catch {
      // 代理探测失败不拦截，发品侧终校验
      const next = [...images]
      next[idx] = url
      onChange(next)
    } finally {
      setUploading(false)
      setUploadingIdx(null)
    }
  }

  const SLOTS = ["正拍图", "侧拍图", "俯拍图"]
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {SLOTS.map((label, i) => (
          <div key={label} className="space-y-1">
            {images[i] ? (
              <div className="group relative size-20 overflow-hidden rounded-md border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={images[i]!} alt={label} className="size-full object-cover" />
                <button
                  type="button"
                  className="absolute inset-0 hidden items-center justify-center bg-black/50 group-hover:flex"
                  onClick={() => {
                    const next = [...images]
                    next[i] = null
                    onChange(next)
                  }}
                >
                  <Trash2 className="size-4 text-white" />
                </button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="size-20 flex-col gap-1"
                disabled={uploading}
                onClick={() => setPicking(i)}
              >
                {uploadingIdx === i ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ImagePlus className="size-4" />
                )}
                <span className="text-[10px]">{label}</span>
              </Button>
            )}
          </div>
        ))}
      </div>
      <ImageLibraryDialog
        open={picking != null}
        onOpenChange={(o) => !o && setPicking(null)}
        assets={assets}
        onUploaded={(img) => setAssets((prev) => [img, ...prev])}
        onSelect={(url) => {
          if (picking != null) void pick(picking, url)
        }}
      />
    </div>
  )
}
