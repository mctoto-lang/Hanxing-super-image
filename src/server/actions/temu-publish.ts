"use server"

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm"
import { db } from "@/db/client"
import {
  temuPublishRecords,
  temuPublishTemplates,
  temuStores,
  type TemuTemplateAttr,
  type TemuTemplateDefaults,
} from "@/db/schema/temu"
import {
  getCurrentEnterpriseScope,
  requireEnterpriseAdmin,
  requireEnterpriseContext,
} from "@/lib/auth/session"
import {
  callTemuApi,
  isTemuPermissionError,
  isTemuTokenExpired,
  type TemuCallContext,
} from "@/lib/temu-api/client"
import { getTemuCallContext } from "@/server/services/temu-sync"
import { temuCached, invalidateTemuCache } from "@/server/services/temu-cache"
import { isAllowedDownloadHost } from "@/lib/storage/cos"
import { loadStorageConfig, type StorageConfig } from "@/lib/storage/config"
import {
  temuAttrTemplateQuerySchema,
  temuCategoryQuerySchema,
  temuPublishActionSchema,
  temuPublishImageSchema,
  temuPublishGuideFileSchema,
  temuPublishRecordsQuerySchema,
  temuPublishTemplateSchema,
  temuPublishTemplateUpdateSchema,
  temuImageCompressSchema,
  temuDimensionCheckSchema,
} from "@/server/schemas/temu"

/**
 * TEMU 刊登模板 Server Actions（模板化发品 M2：非服饰全托）
 *
 * 模板三层（骨架锁定 + 素材可覆盖）：类目链/属性/规格定义/产地/重量/体积/敏感锁定，
 * 标题/图片/申报价/货号为默认层、发品时可覆盖。发品仅能基于模板。
 * 官方接口口径全部来自 2026-10-20 实测（docs/temu-openapi-guide.md §8.12）：
 * 类目钻取用 parentCatId、属性父子联动、非服饰规格走 spec.create 自建（店铺级幂等）、
 * mainProductSkuSpecReqs 固定零值、素材图 1:1 ≥800×800。
 *
 * 权限：查询 requireEnterpriseContext；模板写与发品 requireEnterpriseAdmin。
 */

/* ─── 公共守卫 ─── */

type StoreRow = typeof temuStores.$inferSelect
type TemplateRow = typeof temuPublishTemplates.$inferSelect

async function requireOwnedTemplate(
  templateId: string,
  admin: boolean,
): Promise<{ ok: true; template: TemplateRow } | { ok: false; error: string }> {
  const ctx = admin ? await requireEnterpriseAdmin() : await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const [row] = await db
    .select()
    .from(temuPublishTemplates)
    .where(
      and(eq(temuPublishTemplates.id, templateId), eq(temuPublishTemplates.enterpriseId, enterpriseId)),
    )
    .limit(1)
  if (!row) return { ok: false, error: "模板不存在" }
  return { ok: true, template: row }
}

async function requirePublishStore(
  storeId: string,
): Promise<{ ok: true; store: StoreRow } | { ok: false; error: string }> {
  await requireEnterpriseAdmin()
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const [store] = await db
    .select()
    .from(temuStores)
    .where(and(eq(temuStores.id, storeId), eq(temuStores.enterpriseId, enterpriseId)))
    .limit(1)
  if (!store) return { ok: false, error: "店铺不存在或不属于当前企业" }
  if (!store.enabled) return { ok: false, error: "店铺已停用" }
  if (store.mallType === "semi") return { ok: false, error: "半托店铺发品暂未接入（M2 一期为全托）" }
  return { ok: true, store }
}

/** 外包装类官方错误指引（通路已通：imageBizType=1 上传；缺图/不全=补配模板） */
const PKG_HINT =
  "。该类目强制完整外包装信息：请在模板中补齐外包装照片（建议 正拍/侧拍/俯拍 三视角）与形状/类型后重试"

async function toPublishError(storeId: string, err: unknown): Promise<string> {
  const message = err instanceof Error ? err.message : String(err)
  if (isTemuTokenExpired(err)) {
    await db
      .update(temuStores)
      .set({ tokenState: "invalid", updatedAt: new Date() })
      .where(eq(temuStores.id, storeId))
    return "access_token 已过期，请在店铺管理重新录入"
  }
  if (isTemuPermissionError(err)) {
    return "店铺 token 未授权该接口组（卖家中心授权勾选需含货品API组）"
  }
  const text = message.slice(0, 800) || "官方接口调用失败"
  if (
    text.includes("Outer package image is required") ||
    text.includes("Outer packaging information is incomplete") ||
    text.includes("Invalid image links")
  ) {
    return text + PKG_HINT
  }
  return text
}

/* ─── 类目 / 属性 / 规格（实时拉取 + 30s 缓存） ─── */

export interface TemuCategoryNode {
  catId: number
  catName: string
  isLeaf: boolean
}

/** 类目查询：keyword → category.match（searchText，返回完整类目链）；parentCatId → cats.get 钻取（0=根） */
export async function searchTemuCategoriesAction(
  input: { keyword?: string; parentCatId?: number },
): Promise<
  | { ok: true; rows: TemuCategoryNode[]; chains?: TemuCategoryNode[][] }
  | { ok: false; error: string }
> {
  const q = temuCategoryQuerySchema.parse(input)
  try {
    const enterpriseId = await currentEnterpriseId()
    if (q.keyword) {
      return temuCached(`${enterpriseId}:pub:cat:match:${q.keyword}`, async () => {
        const r = await callTemuApi<{
          categoryPathDTOS?: Array<Record<string, unknown>>
        }>("bg.glo.goods.category.match", { searchText: q.keyword }, await publishCtx())
        // cat1DTO..cat10DTO 完整链必须整体使用——只取叶子会让 goods.add 类目链
        // 不完整而报 6000011 所选类目不合法（实测教训）
        const chains: TemuCategoryNode[][] = []
        for (const path of r.result.categoryPathDTOS ?? []) {
          const levels = pickCatChain(path)
          if (levels.length > 0 && levels[levels.length - 1]!.isLeaf) chains.push(levels)
        }
        return { ok: true as const, rows: [], chains }
      })
    }
    const parent = q.parentCatId ?? 0
    return temuCached(`${enterpriseId}:pub:cat:children:${parent}`, async () => {
      const r = await callTemuApi<{
        categoryDTOList?: Array<{ catId: number; catName: string; isLeaf: boolean; isHidden?: boolean }>
      }>("bg.glo.goods.cats.get", { parentCatId: parent }, await publishCtx())
      const rows = (r.result.categoryDTOList ?? []).filter((c) => !c.isHidden)
      return { ok: true as const, rows }
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }
}

/** 从 category.match 的 cat1DTO..cat10DTO 提取实际链（含叶子标记） */
function pickCatChain(path: Record<string, unknown>): TemuCategoryNode[] {
  const out: TemuCategoryNode[] = []
  for (let i = 1; i <= 10; i++) {
    const dto = path[`cat${i}DTO`] as Record<string, unknown> | undefined
    if (!dto || typeof dto.catId !== "number") break
    out.push({
      catId: dto.catId,
      catName: String(dto.catName ?? ""),
      isLeaf: dto.isLeaf === true,
    })
  }
  return out
}

export interface TemuAttrValue {
  vid: number
  value: string
  /** 合法父 vid 集（父子联动） */
  parentVidList: number[]
}

export interface TemuAttrProperty {
  templatePid: number
  pid: number
  refPid: number
  parentTemplatePid: number
  name: string
  required: boolean
  isSale: boolean
  controlType: number
  inputMaxNum: number
  values: TemuAttrValue[]
}

export interface TemuAttrTemplate {
  templateId: number
  /** 自定义规格上限（0=不允许自定义规格） */
  inputMaxSpecNum: number
  properties: TemuAttrProperty[]
}

/** 叶子类目属性模板（attrs.get；父规格信息另走 parentspec） */
export async function getTemuAttrTemplateAction(
  input: { catId: number },
): Promise<{ ok: true; template: TemuAttrTemplate } | { ok: false; error: string }> {
  const q = temuAttrTemplateQuerySchema.parse(input)
  try {
    const enterpriseId = await currentEnterpriseId()
    return temuCached(`${enterpriseId}:pub:attrs:${q.catId}`, async () => {
      const r = await callTemuApi<Record<string, unknown>>(
        "bg.glo.goods.attrs.get",
        { catId: q.catId },
        await publishCtx(),
      )
      const props = Array.isArray(r.result.properties)
        ? (r.result.properties as Array<Record<string, unknown>>)
        : []
      const properties: TemuAttrProperty[] = props.map((p) => ({
        templatePid: num(p.templatePid) ?? 0,
        pid: num(p.pid) ?? 0,
        refPid: num(p.refPid) ?? 0,
        parentTemplatePid: num(p.parentTemplatePid) ?? 0,
        name: str(p.name) ?? "",
        required: p.required === true,
        isSale: p.isSale === true,
        controlType: num(p.controlType) ?? 0,
        inputMaxNum: num(p.inputMaxNum) ?? 0,
        values: (Array.isArray(p.values) ? (p.values as Array<Record<string, unknown>>) : []).map((v) => ({
          vid: num(v.vid) ?? 0,
          value: str(v.value) ?? "",
          parentVidList: Array.isArray(v.parentVidList)
            ? (v.parentVidList as unknown[]).map((x) => num(x) ?? 0).filter((x) => x > 0)
            : [],
        })),
      }))
      return {
        ok: true as const,
        template: {
          templateId: num(r.result.templateId) ?? 0,
          inputMaxSpecNum: num(r.result.inputMaxSpecNum) ?? 0,
          properties,
        },
      }
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }
}

export interface TemuParentSpec {
  parentSpecId: number
  parentSpecName: string
}

/** 父规格列表（parentspec.get 空参；自建规格用） */
export async function listTemuParentSpecsAction(): Promise<
  { ok: true; rows: TemuParentSpec[] } | { ok: false; error: string }
> {
  try {
    const enterpriseId = await currentEnterpriseId()
    return temuCached(`${enterpriseId}:pub:parentspecs`, async () => {
      const r = await callTemuApi<{
        parentSpecDTOS?: Array<{ parentSpecId?: number; parentSpecName?: string }>
      }>("bg.glo.goods.parentspec.get", {}, await publishCtx())
      const rows = (r.result.parentSpecDTOS ?? [])
        .filter((x) => typeof x.parentSpecId === "number")
        .map((x) => ({ parentSpecId: x.parentSpecId!, parentSpecName: x.parentSpecName ?? "" }))
      return { ok: true as const, rows }
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }
}

async function currentEnterpriseId(): Promise<string> {
  const ctx = await requireEnterpriseContext()
  return getCurrentEnterpriseScope(ctx).enterpriseId
}

/** 类目/属性查询的调用凭证：任一 token 可用（active 且已录入）的启用店铺
 *  （平台级类目数据与店铺无关，取第一家可用店；首店失效自动顺延下一家） */
async function publishCtx(): Promise<TemuCallContext> {
  const enterpriseId = await currentEnterpriseId()
  // 只选 tokenState=active 且已录入密文的启用店：无 token/已失效（7000007
  // 回写 invalid）的首店不再拖垮全链路；sortOrder 同序按 createdAt 稳定
  // （与 schema 注释「默认 0 按 createdAt」对齐）
  const [store] = await db
    .select()
    .from(temuStores)
    .where(
      and(
        eq(temuStores.enterpriseId, enterpriseId),
        eq(temuStores.enabled, true),
        isNotNull(temuStores.accessTokenEncrypted),
        eq(temuStores.tokenState, "active"),
      ),
    )
    .orderBy(temuStores.sortOrder, temuStores.createdAt)
    .limit(1)
  if (!store) throw new Error("企业暂无启用且已录入 token 的店铺，无法查询类目/属性")
  const built = await getTemuCallContext(store)
  if ("error" in built) throw new Error(built.error)
  return built
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return null
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/* ─── 模板 CRUD（管理员） ─── */

export interface TemuPublishTemplateRow {
  id: string
  name: string
  categoryChain: Array<{ catId: number; catName: string; isLeaf: boolean }>
  specConfig: { parentSpecId: number; parentSpecName: string; specName: string }
  defaults: TemuTemplateDefaults
  /** 原始属性选定值（编辑回填用；templatePid 是否过期由向导重拉模板核对） */
  attributes: TemuTemplateAttr[]
  attributeCount: number
  createdAt: string
  updatedAt: string
}

export async function listPublishTemplatesAction(): Promise<
  { ok: true; rows: TemuPublishTemplateRow[] } | { ok: false; error: string }
> {
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const rows = await db
    .select()
    .from(temuPublishTemplates)
    .where(eq(temuPublishTemplates.enterpriseId, enterpriseId))
    .orderBy(desc(temuPublishTemplates.updatedAt))
  return {
    ok: true,
    rows: rows
      .filter((r) => r.status !== "archived")
      .map((r) => ({
        id: r.id,
        name: r.name,
        categoryChain: r.categoryChain,
        specConfig: r.specConfig,
        // base64 PDF 源仅存库（发品时按目标店重传用），列表响应剥离避免体积膨胀
        defaults: r.defaults.guideFile?.base64
          ? (() => {
              const guide = { ...r.defaults.guideFile! }
              delete guide.base64
              return { ...r.defaults, guideFile: guide }
            })()
          : r.defaults,
        attributes: r.attributes,
        attributeCount: r.attributes.length,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
  }
}

export async function createPublishTemplateAction(
  input: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const ctx = await requireEnterpriseAdmin()
    const q = temuPublishTemplateSchema.parse(input)
    const { enterpriseId } = getCurrentEnterpriseScope(ctx)
    const [row] = await db
      .insert(temuPublishTemplates)
      .values({
        enterpriseId,
        name: q.name,
        status: "active",
        createdBy: ctx.user.id,
        categoryChain: q.categoryChain,
        leafCategoryId: q.categoryChain[q.categoryChain.length - 1]!.catId,
        attributes: q.attributes,
        specConfig: q.specConfig,
        defaults: q.defaults,
      })
      .returning({ id: temuPublishTemplates.id })
    invalidateTemuCache(enterpriseId)
    return { ok: true, id: row!.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }
}

export async function updatePublishTemplateAction(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireEnterpriseAdmin()
    // 编辑回填的 defaults 不含 base64（列表已剥离、向导不回传源）：必须先取库内模板、
    // 在 parse 前注入存量 PDF 源，否则 guideFile 的 refine「缺少 PDF 源」会先炸
    const rawId = (input as { id?: unknown } | null)?.id
    const guard = await requireOwnedTemplate(typeof rawId === "string" ? rawId : "", true)
    if (!guard.ok) return guard
    const storedGuide = guard.template.defaults.guideFile
    const raw = input as { defaults?: { guideFile?: Record<string, unknown> } }
    const rawGuide = raw.defaults?.guideFile
    if (storedGuide && rawGuide && !rawGuide.base64 && !rawGuide.pdfMaterialId) {
      const sameGuide =
        storedGuide.pdfMaterialId === rawGuide.pdfMaterialId ||
        storedGuide.fileName === rawGuide.fileName
      if (sameGuide) {
        raw.defaults!.guideFile = {
          ...rawGuide,
          ...(storedGuide.base64
            ? { base64: storedGuide.base64 }
            : { pdfMaterialId: storedGuide.pdfMaterialId }),
        }
      }
    }
    const q = temuPublishTemplateUpdateSchema.parse(input)
    await db
      .update(temuPublishTemplates)
      .set({
        name: q.name,
        categoryChain: q.categoryChain,
        leafCategoryId: q.categoryChain[q.categoryChain.length - 1]!.catId,
        attributes: q.attributes,
        specConfig: q.specConfig,
        defaults: q.defaults,
        updatedAt: new Date(),
      })
      .where(eq(temuPublishTemplates.id, q.id))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }
}

/** 删除模板（软删=archived，列表即不可见不可发；无草稿/停用态，删除即不可用） */
export async function deletePublishTemplateAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const guard = await requireOwnedTemplate(id, true)
  if (!guard.ok) return guard
  await db
    .update(temuPublishTemplates)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(temuPublishTemplates.id, id))
  return { ok: true }
}

/* ─── 素材上传（图库/外链 → 官方图床 + 牛皮癣检测） ─── */

/** 图片源白名单配置缓存（60s TTL，口径同 /api/image/proxy 的 getCachedStorageConfig） */
let imgSrcCfgCache: { at: number; cfg: StorageConfig } | null = null

/**
 * 服务端回拉图片源前的 host 白名单校验（防 SSRF）：复用 cos.ts
 * isAllowedDownloadHost 同一口径（https + COS 桶域名 + 云存储/AI 上游后缀 +
 * system_setting allowedDownloadHosts），另放行 TEMU 官方图床（模板默认层/
 * 轮播复用会回存 temuUrl 源），拒绝内网/任意外链地址被服务端拉取。
 */
const TEMU_IMAGE_HOST_SUFFIX = ".kwcdn.com"

async function assertAllowedImageSource(src: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(src)
  } catch {
    throw new Error("图片来源 URL 无效")
  }
  if (!imgSrcCfgCache || Date.now() - imgSrcCfgCache.at > 60_000) {
    imgSrcCfgCache = { at: Date.now(), cfg: await loadStorageConfig() }
  }
  if (
    !isAllowedDownloadHost(parsed, imgSrcCfgCache.cfg) &&
    !parsed.hostname.endsWith(TEMU_IMAGE_HOST_SUFFIX)
  ) {
    throw new Error(
      `图片来源域名不在允许列表：${parsed.hostname}（如需外链图库，请在系统存储设置 allowedDownloadHosts 中配置）`,
    )
  }
}

export interface TemuUploadedImage {
  temuUrl: string
  /** 牛皮癣 true=有牛皮癣（官方可能拒审，提示用户） */
  hasSpot: boolean
  width: number
  height: number
  bytes: number
}

/**
 * 按指定店铺上传图片到 TEMU 官方图床（模板存源、发品时逐张换新——图片素材与 PDF 同为店铺级）。
 * src 支持 http(s) 源 URL 或 data:image/...（浏览器压缩产物）；
 * kind=material 校验 1:1 ≥800×800 ≤2M，kind=package 仅校验 ≤2M 与格式。
 */
async function uploadImageToStore(
  src: string,
  ctx: TemuCallContext,
  kind: "material" | "package",
): Promise<{ url: string; bytes: number }> {
  let buf: Buffer
  let mime: string
  if (src.startsWith("data:")) {
    const [prefix, b64] = src.split(",")
    mime = prefix!.slice(5, prefix!.indexOf(";"))
    buf = Buffer.from(b64!, "base64")
  } else {
    await assertAllowedImageSource(src)
    const res = await fetch(src, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`图片拉取失败（HTTP ${res.status}）`)
    buf = Buffer.from(await res.arrayBuffer())
    mime = res.headers.get("content-type") ?? sniffMime(buf)
  }
  if (buf.length > 2 * 1024 * 1024) throw new Error("图片超过 2M 上限（官方 2000021）")
  if (!["image/jpeg", "image/png"].includes(mime)) throw new Error("仅支持 JPG/PNG（官方 2000021）")
  const dim = readImageDim(buf)
  if (!dim) throw new Error("无法解析图片尺寸（仅支持 JPG/PNG）")
  if (kind === "material") {
    if (dim.width < 800 || dim.height < 800) {
      throw new Error(`图片 ${dim.width}×${dim.height} 不满足最小 800×800（官方 2000017）`)
    }
    if (dim.width !== dim.height) {
      throw new Error(`素材图须 1:1（当前 ${dim.width}×${dim.height}，官方 2000017）`)
    }
  }
  const up = await callTemuApi<{ imageUrl?: string }>(
    "bg.goods.image.upload.global",
    {
      image: `data:${mime};base64,${buf.toString("base64")}`,
      // 外包装图必须用 imageBizType=1：返回私域桶（product-material-private-tag）URL，
      // 普通商品图 URL 提交包装位会被「Invalid image links」拒（实测，SDK 文档同口径）
      ...(kind === "package" ? { imageBizType: 1 } : {}),
    },
    ctx,
  )
  if (!up.result.imageUrl) throw new Error("官方图床未返回地址")
  return { url: up.result.imageUrl, bytes: buf.length }
}

/**
 * 上传素材图到 TEMU 官方图床并做牛皮癣检测。
 * 本地预校验官方硬口径：1:1、≥800×800、≤2M、JPG/PNG（2000017/2000021）。
 */
export async function uploadPublishImageAction(
  input: { imageUrl?: string; imageDataUrl?: string; kind?: "material" | "package" },
): Promise<{ ok: true; image: TemuUploadedImage } | { ok: false; error: string }> {
  const q = temuPublishImageSchema.parse(input)
  const kind = input.kind ?? "material"
  try {
    await requireEnterpriseAdmin()
    let buf: Buffer
    let mime: string
    if (q.imageDataUrl) {
      // 浏览器压缩直传：data:image/xxx;base64 解码
      const [prefix, b64] = q.imageDataUrl.split(",")
      mime = prefix!.slice(5, prefix!.indexOf(";"))
      buf = Buffer.from(b64!, "base64")
    } else {
      await assertAllowedImageSource(q.imageUrl!)
      const res = await fetch(q.imageUrl!, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) return { ok: false, error: `图片拉取失败（HTTP ${res.status}）` }
      buf = Buffer.from(await res.arrayBuffer())
      mime = res.headers.get("content-type") ?? sniffMime(buf)
    }
    if (buf.length > 2 * 1024 * 1024) return { ok: false, error: "图片超过 2M 上限（官方 2000021）" }
    if (!["image/jpeg", "image/png"].includes(mime)) {
      return { ok: false, error: "仅支持 JPG/PNG（官方 2000021）" }
    }
    const dim = readImageDim(buf)
    if (!dim) return { ok: false, error: "无法解析图片尺寸（仅支持 JPG/PNG）" }
    if (kind === "material") {
      if (dim.width < 800 || dim.height < 800) {
        return { ok: false, error: `图片 ${dim.width}×${dim.height} 不满足最小 800×800（官方 2000017）` }
      }
      if (dim.width !== dim.height) {
        return { ok: false, error: `素材图须 1:1（当前 ${dim.width}×${dim.height}，官方 2000017）` }
      }
    }
    const up = await callTemuApi<{ imageUrl?: string }>(
      "bg.goods.image.upload.global",
      { image: `data:${mime};base64,${buf.toString("base64")}` },
      await publishCtx(),
    )
    const temuUrl = up.result.imageUrl ?? ""
    if (!temuUrl) return { ok: false, error: "官方图床未返回地址" }
    let hasSpot = false
    try {
      const spot = await callTemuApi<{ list?: Array<{ hasSpot?: string }> }>(
        "bg.compliancepicture.get.global",
        { urlList: [temuUrl] },
        await publishCtx(),
      )
      hasSpot = spot.result.list?.[0]?.hasSpot === "true"
    } catch {
      // 牛皮癣检测失败不阻断上传（5000000 处理中常见，重试由用户决定）
    }
    return {
      ok: true,
      image: { temuUrl, hasSpot, width: dim.width, height: dim.height, bytes: buf.length },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }
}

/** PNG（IHDR）/ JPEG（SOF 帧）尺寸解析，零依赖 */
function readImageDim(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) break
      const marker = buf[off + 1]!
      const size = buf.readUInt16BE(off + 2)
      // SOF0..SOF15（不含 DHT/DAC/RST 等）
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
      }
      off += 2 + size
    }
  }
  return null
}

function sniffMime(buf: Buffer): string {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50) return "image/png"
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg"
  return "application/octet-stream"
}

/** 电子说明书 PDF 上传：base64 → instructions.upload → pdfId（发品时随 productGuideFileReqs 提交） */
export async function uploadPublishGuideFileAction(
  input: { base64File: string; fileName: string },
): Promise<{ ok: true; pdfMaterialId: number } | { ok: false; error: string }> {
  const q = temuPublishGuideFileSchema.parse(input)
  try {
    await requireEnterpriseAdmin()
    const r = await callTemuApi<{ pdfId?: number }>(
      "bg.glo.goods.instructions.upload",
      { base64File: q.base64File },
      await publishCtx(),
    )
    if (!r.result.pdfId) return { ok: false, error: "官方接口未返回 pdfId" }
    return { ok: true, pdfMaterialId: r.result.pdfId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }
}

/* ─── 官方图片工具（压缩 / 尺寸图校验） ─── */

export interface TemuCompressedImage {
  originUrl: string
  resultUrl: string
  width: number | null
  height: number | null
  /** 压缩产物字节数（官方返回 size） */
  size: number | null
}

/**
 * 官方高清图压缩（bg.glo.picturecompression.get）。
 * 仅接受官方图床 URL（img.kwcdn.com，实测外部 URL/data: 均 100100000 算法服务拒）；
 * 用于已上图床的图保质量缩减（轮播复用/换图场景），>2M 源图仍走浏览器压缩链路。
 */
export async function compressTemuImagesAction(
  input: { urls: string[] },
): Promise<{ ok: true; results: TemuCompressedImage[] } | { ok: false; error: string }> {
  const q = temuImageCompressSchema.parse(input)
  try {
    await requireEnterpriseAdmin()
    const r = await callTemuApi<{ results?: Array<Record<string, unknown>> }>(
      "bg.glo.picturecompression.get",
      { urls: q.urls },
      await publishCtx(),
    )
    const results: TemuCompressedImage[] = []
    for (const it of r.result.results ?? []) {
      const originUrl = typeof it.originUrl === "string" ? it.originUrl : ""
      const resultUrl = typeof it.resultUrl === "string" ? it.resultUrl : ""
      if (!originUrl || !resultUrl) continue
      results.push({
        originUrl,
        resultUrl,
        width: typeof it.width === "number" ? it.width : null,
        height: typeof it.height === "number" ? it.height : null,
        size: typeof it.size === "number" ? it.size : null,
      })
    }
    if (results.length === 0) return { ok: false, error: "官方压缩未返回结果（请确认 URL 为官方图床地址）" }
    return { ok: true, results }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("100100000")) {
      return { ok: false, error: "官方压缩仅支持官方图床（img.kwcdn.com）URL——外链/本地图片请先经发品上传或浏览器压缩" }
    }
    return { ok: false, error: msg.slice(0, 300) }
  }
}

export interface TemuDimensionCheckResult {
  /** processing=官方仍在识别（可稍后重试）；done=识别结束（结论看 message/imageType） */
  status: "processing" | "done"
  /** 官方图片类型枚举（未文档化，实测恒 2；疑似 1=尺寸图） */
  imageType: number | null
  message: string
}

/** 尺寸图校验（发品链路内嵌版）：提交 + 最多 2 次轮询（3s 间隔），
 *  任何异常吞掉返回 undefined——参考性校验绝不阻断发品 */
async function checkDimensionBestEffort(
  imageUrl: string,
  ctx: TemuCallContext,
): Promise<TemuDimensionCheckResult | undefined> {
  try {
    const submit = await callTemuApi<{ uniqueId?: string }>(
      "bg.algo.dimension.image.check",
      { imageUrl },
      ctx,
    )
    const uniqueId = submit.result.uniqueId
    if (!uniqueId) return undefined
    for (let i = 0; i < 2; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 3000))
      const r = await callTemuApi<{
        errorCode?: number
        imageType?: number | null
        errorMsg?: string
      }>("bg.algo.dimension.image.check.result", { uniqueId }, ctx)
      if (r.result.errorCode === 5000000) continue
      return {
        status: "done",
        imageType: typeof r.result.imageType === "number" ? r.result.imageType : null,
        message: r.result.errorMsg?.trim() || "校验完成",
      }
    }
    return { status: "processing", imageType: null, message: "官方识别中（结论稍后可在图片工具重查）" }
  } catch {
    return undefined
  }
}

/**
 * 尺寸图校验（bg.algo.dimension.image.check 两段式异步：提交 imageUrl →
 * uniqueId → check.result 轮询）。服务端最多轮询 3 次×3s，超时返回 processing
 * 由前端提示稍后重试。⚠️ 参考性校验：识别服务实测对图源有隐性要求（一律
 * 「图片md5获取失败」§8.14），结论不阻断发品。
 */
export async function checkTemuDimensionImageAction(
  input: { imageUrl: string },
): Promise<{ ok: true; result: TemuDimensionCheckResult } | { ok: false; error: string }> {
  const q = temuDimensionCheckSchema.parse(input)
  try {
    await requireEnterpriseAdmin()
    const ctx = await publishCtx()
    const submit = await callTemuApi<{ uniqueId?: string }>(
      "bg.algo.dimension.image.check",
      { imageUrl: q.imageUrl },
      ctx,
    )
    const uniqueId = submit.result.uniqueId
    if (!uniqueId) return { ok: false, error: "官方接口未返回校验任务号" }
    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 3000))
      const r = await callTemuApi<{
        errorCode?: number
        imageType?: number | null
        errorMsg?: string
      }>("bg.algo.dimension.image.check.result", { uniqueId }, ctx)
      // 内层 errorCode 5000000=检测中（与 envelope 层错误码不同空间）
      if (r.result.errorCode === 5000000) continue
      return {
        ok: true,
        result: {
          status: "done",
          imageType: typeof r.result.imageType === "number" ? r.result.imageType : null,
          message: r.result.errorMsg?.trim() || "校验完成",
        },
      }
    }
    return { ok: true, result: { status: "processing", imageType: null, message: "官方识别中，请稍后重试" } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) }
  }
}

/* ─── 发品（管理员） ─── */

export interface TemuPublishResult {
  ok: boolean
  /** 成功时的官方货品 id */
  productId?: string
  error?: string
  /** 尺寸图官方校验结论（参考性，配置了尺寸图才有；不阻断发品） */
  dimensionCheck?: {
    status: "processing" | "done"
    message: string
    imageType: number | null
  }
}

/** 基于模板发品：锁定层自模板、默认层+覆盖合并 → spec.create 幂等换规格 → goods.add → 落记录 */
export async function publishFromTemplateAction(
  input: { templateId: string; storeId: string; overrides?: Record<string, unknown> },
): Promise<TemuPublishResult> {
  let storeId = ""
  /** 已组装的 goods.add 请求（失败记录快照用） */
  let builtBody: Record<string, unknown> | null = null
  try {
    const q = temuPublishActionSchema.parse(input)
    storeId = q.storeId
    const storeGuard = await requirePublishStore(q.storeId)
    if (!storeGuard.ok) return { ok: false, error: storeGuard.error }
    const tplGuard = await requireOwnedTemplate(q.templateId, true)
    if (!tplGuard.ok) return { ok: false, error: tplGuard.error }
    const tpl = tplGuard.template
    if (tpl.status === "archived") return { ok: false, error: "模板已删除" }

    // 默认层 + 覆盖合并（锁定层字段不受覆盖影响）
    const d = tpl.defaults
    const eff = {
      title: q.overrides.title?.trim() || d.title,
      imageUrls: q.overrides.imageUrls?.length ? q.overrides.imageUrls : d.imageUrls,
      declaredPriceFen: q.overrides.declaredPriceFen ?? d.declaredPriceFen,
      extCode: q.overrides.extCode ?? d.extCode,
    }
    const pre = precheck(tpl, eff)
    if (pre) return { ok: false, error: pre }
    // 官方最少 5 张按最终轮播计数：素材 + 尺寸图（尺寸图提交时插回轮播第 2 位）
    const carouselTotal =
      eff.imageUrls.length +
      ((q.overrides.dimensionImageUrl ?? d.dimensionImageUrl ?? null) ? 1 : 0)
    if (carouselTotal < 5) {
      return { ok: false, error: "轮播图至少 5 张（官方非服饰规则，含第 2 位尺寸图；可在模板或发品时补传）" }
    }

    const built = await getTemuCallContext(storeGuard.store)
    if ("error" in built) return { ok: false, error: built.error }
    const ctx = built

    // 店铺级自建规格（同名幂等，实测返回同一 specId）
    const spec = await callTemuApi<{ specId?: number }>(
      "bg.glo.goods.spec.create",
      { parentSpecId: tpl.specConfig.parentSpecId, specName: tpl.specConfig.specName },
      ctx,
    )
    const specId = spec.result.specId
    if (!specId) return { ok: false, error: "spec.create 未返回 specId" }

    // 说明书 pdfId 是店铺级素材：发品到其他店会「查询素材中心pdf文件信息失败」（实测）——
    // 模板存有 PDF 源时按目标店铺重传换新 pdfId
    let tplForBody = tpl
    const guide = tpl.defaults.guideFile
    if (guide?.base64) {
      try {
        const reUp = await callTemuApi<{ pdfId?: number }>(
          "bg.glo.goods.instructions.upload",
          { base64File: guide.base64 },
          ctx,
        )
        if (reUp.result.pdfId) {
          tplForBody = {
            ...tpl,
            defaults: { ...tpl.defaults, guideFile: { ...guide, pdfMaterialId: reUp.result.pdfId } },
          }
        }
      } catch (err) {
        return {
          ok: false,
          error: `说明书重传失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
        }
      }
    }

    // 素材/包装图逐张按目标店铺上传官方图床（模板存源；图片素材与 PDF 同为店铺级）
    const materialUploads: Array<{ url: string; bytes: number }> = []
    for (let i = 0; i < eff.imageUrls.length; i++) {
      try {
        materialUploads.push(await uploadImageToStore(eff.imageUrls[i]!, ctx, "material"))
      } catch (err) {
        return {
          ok: false,
          error: `素材图第 ${i + 1} 张上传失败：${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
    // 官方高清压缩（probe9 实证 fancy URL 可作轮播图，2026-10-21）：上传体积 >1MB
    // 的素材批量压缩换 resultUrl——失败/无结果回落原图，绝不阻断发品
    const oversizedIdx = materialUploads
      .map((u, i) => ({ u, i }))
      .filter((x) => x.u.bytes > 1_000_000)
      .slice(0, 10)
    if (oversizedIdx.length > 0) {
      try {
        const comp = await callTemuApi<{
          results?: Array<{ originUrl?: string; resultUrl?: string }>
        }>(
          "bg.glo.picturecompression.get",
          { urls: oversizedIdx.map((x) => x.u.url) },
          ctx,
        )
        const byOrigin = new Map<string, string>()
        for (const r of comp.result.results ?? []) {
          if (r.originUrl && r.resultUrl) byOrigin.set(r.originUrl, r.resultUrl)
        }
        for (const x of oversizedIdx) {
          const fancy = byOrigin.get(x.u.url)
          if (fancy) materialUploads[x.i] = { url: fancy, bytes: x.u.bytes }
        }
      } catch {
        // 官方压缩失败回落原图（原图本就合规——≤2M 已过上传闸门）
      }
    }
    const materialTemuUrls = materialUploads.map((u) => u.url)
    // 外包装图按目标店以 imageBizType=1 上传（返回私域桶 URL，包装位唯一合规来源）
    const pkgTemuUrls: string[] = []
    const pkgSources = tpl.defaults.outerPackageImages ?? []
    for (let i = 0; i < pkgSources.length; i++) {
      try {
        pkgTemuUrls.push((await uploadImageToStore(pkgSources[i]!, ctx, "package")).url)
      } catch (err) {
        return {
          ok: false,
          error: `外包装图第 ${i + 1} 张上传失败：${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
    // 尺寸图按目标店上传（与轮播同口径 1:1 ≥800），提交时固定插到第 2 张
    // （卖家中心页面口径；API 实测不校验位置 §8.15）；覆盖层优先于模板
    const dimensionSource = q.overrides.dimensionImageUrl ?? tpl.defaults.dimensionImageUrl ?? null
    let dimensionTemuUrl: string | null = null
    let dimensionCheck: TemuPublishResult["dimensionCheck"]
    if (dimensionSource) {
      try {
        const dimUp = await uploadImageToStore(dimensionSource, ctx, "material")
        dimensionTemuUrl = dimUp.url
        // 尺寸图官方校验（两段式，参考性结论不阻断发品——识别服务实测恒
        // 「图片md5获取失败」，结论随发品结果返回如实展示）
        dimensionCheck = await checkDimensionBestEffort(dimUp.url, ctx)
      } catch (err) {
        return {
          ok: false,
          error: `尺寸图上传失败：${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    const body = buildGoodsAddBody(tplForBody, eff, specId, materialTemuUrls, pkgTemuUrls, dimensionTemuUrl)
    builtBody = body
    const r = await callTemuApi<{
      productId?: number
      productSkcList?: Array<{ productSkcId?: number }>
      productSkuList?: Array<{ productSkuId?: number }>
    }>("bg.glo.goods.add", body, ctx)
    const productId = idStr(r.result.productId, 32)

    // 成功后回查 token 实际归属店（串店排障直达：店铺定向只看 token，选店与归属不符即发错店）
    let actualMallName: string | undefined
    try {
      const info = await callTemuApi<{ mallName?: string }>(
        "bg.open.accesstoken.info.get.global",
        {},
        ctx,
      )
      actualMallName = info.result.mallName ?? undefined
      if (actualMallName && storeGuard.store.mallName && actualMallName !== storeGuard.store.mallName) {
        console.warn(
          `[temu-publish] 店铺「${storeGuard.store.name}」token 实际归属「${actualMallName}」，请核对店铺 token`,
        )
      }
    } catch {
      // 归属回查失败不影响发品结果
    }
    await db.insert(temuPublishRecords).values({
      enterpriseId: storeGuard.store.enterpriseId,
      templateId: tpl.id,
      storeId: q.storeId,
      userId: null,
      overrides: q.overrides ?? {},
      status: "success",
      productId,
      requestSnapshot: body,
      responseSnapshot: { ...r.result, ...(actualMallName ? { actualMallName } : {}) },
    })
    return { ok: true, productId: productId ?? undefined, ...(dimensionCheck ? { dimensionCheck } : {}) }
  } catch (err) {
    const message = storeId ? await toPublishError(storeId, err) : String(err)
    // 失败也落记录（templateId 已知时）
    try {
      const parsed = temuPublishActionSchema.safeParse(input)
      if (parsed.success) {
        const enterpriseId = await recordEnterpriseId(parsed.data.templateId)
        if (enterpriseId) {
          const apiErr = err as { errorCode?: number }
          await db.insert(temuPublishRecords).values({
            enterpriseId,
            templateId: parsed.data.templateId,
            storeId: parsed.data.storeId,
            overrides: parsed.data.overrides ?? {},
            status: "failed",
            errorCode: typeof apiErr?.errorCode === "number" ? apiErr.errorCode : null,
            errorMsg: message.slice(0, 1000),
            requestSnapshot: builtBody ?? undefined,
          })
        }
      }
    } catch {
      // 记录失败不影响错误返回
    }
    return { ok: false, error: message }
  }
}

function recordEnterpriseId(templateId: string): Promise<string | null> {
  return db
    .select({ enterpriseId: temuPublishTemplates.enterpriseId })
    .from(temuPublishTemplates)
    .where(eq(temuPublishTemplates.id, templateId))
    .limit(1)
    .then((r) => r[0]?.enterpriseId ?? null)
}

/** 本地预检（官方校验前的快速失败；官方侧校验仍以错误码透传为准） */
function precheck(
  tpl: TemplateRow,
  eff: { title: string; imageUrls: string[]; declaredPriceFen: number; extCode: string },
): string | null {
  if (!eff.title.trim()) return "商品名为空"
  if (!/^[A-Za-z0-9._-]*$/.test(eff.extCode)) return "货号仅允许字母、数字与标点（官方 6000018）"
  const v = tpl.defaults.volumeMm
  if (!(v.len >= v.width && v.width >= v.height)) return "体积须满足最长边 ≥ 次长边 ≥ 最短边（官方 2000044）"
  if (tpl.defaults.isSensitive === 1 && !tpl.defaults.sensitiveTypes.length) return "敏感商品缺少敏感类型"
  if (tpl.defaults.isSensitive === 0 && tpl.defaults.maxBatteryCapacityWh) {
    return "非敏感商品不能填写储电容量（官方 1000002）"
  }
  return null
}

/** goods.add 请求组装（锁定层来自模板；口径 docs §8.12） */
function buildGoodsAddBody(
  tpl: TemplateRow,
  eff: { title: string; imageUrls: string[]; declaredPriceFen: number; extCode: string },
  specId: number,
  /** 已按目标店铺上传官方图床的素材图（发品流程逐张换新；单测可直接传 temu URL） */
  materialTemuUrls: string[],
  pkgTemuUrls: string[],
  /** 已按目标店上传的尺寸图（null=模板未配置；插入轮播第 2 张） */
  dimensionTemuUrl: string | null = null,
): Record<string, unknown> {
  const d = tpl.defaults
  const chain = tpl.categoryChain
  const cat = (i: number) => chain[i]?.catId ?? 0
  const specEntry = {
    parentSpecId: tpl.specConfig.parentSpecId,
    parentSpecName: tpl.specConfig.parentSpecName,
    specId,
    specName: tpl.specConfig.specName,
  }
  const attrReqs: Array<Record<string, unknown>> = (tpl.attributes as TemuTemplateAttr[]).map((a) => ({
    templatePid: a.templatePid,
    pid: a.pid,
    refPid: a.refPid,
    propName: a.propName,
    vid: a.vid,
    propValue: a.propValue,
    valueUnit: a.valueUnit ?? "",
    ...(a.numberInputValue ? { numberInputValue: a.numberInputValue } : {}),
  }))
  const imageUrls = materialTemuUrls.length ? materialTemuUrls : eff.imageUrls
  const mainImg = imageUrls[0]!
  // 尺寸图固定第 2 张（卖家中心页面口径；API 实测不校验位置，§8.15）
  const carousel = [...imageUrls]
  if (dimensionTemuUrl) carousel.splice(Math.min(1, carousel.length), 0, dimensionTemuUrl)
  return {
    cat1Id: cat(0),
    cat2Id: cat(1),
    cat3Id: cat(2),
    cat4Id: cat(3),
    cat5Id: cat(4),
    cat6Id: cat(5),
    cat7Id: 0,
    cat8Id: 0,
    cat9Id: 0,
    cat10Id: 0,
    productName: eff.title,
    productPropertyReqs: attrReqs,
    productSpecPropertyReqs: [
      {
        ...specEntry,
        vid: 0,
        refPid: 0,
        pid: 0,
        templatePid: 0,
        propName: tpl.specConfig.parentSpecName,
        propValue: tpl.specConfig.specName,
        valueUnit: "",
        valueGroupId: 0,
        valueGroupName: "",
      },
    ],
    materialImgUrl: mainImg,
    carouselImageUrls: carousel,
    productSkcReqs: [
      {
        previewImgUrls: [mainImg],
        extCode: eff.extCode,
        // 非服饰固定零值（传真实规格反而报「主销售属性不合法」——实测）
        mainProductSkuSpecReqs: [{ parentSpecId: 0, parentSpecName: "", specId: 0, specName: "" }],
        productSkuReqs: [
          {
            thumbUrl: mainImg,
            extCode: eff.extCode,
            currencyType: "CNY",
            supplierPrice: eff.declaredPriceFen,
            productSkuSpecReqs: [specEntry],
            productSkuMultiPackReq: {
              skuClassification: d.skuPack?.skuClassification ?? 1,
              numberOfPieces: d.skuPack?.numberOfPieces ?? 1,
              pieceUnitCode: d.skuPack?.pieceUnitCode ?? 1,
              productSkuNetContentReq: {},
              totalNetContent: {},
              numberOfPiecesNew: d.skuPack?.numberOfPieces ?? 1,
              pieceNewUnitCode: d.skuPack?.pieceUnitCode ?? 1,
            },
            productSkuSuggestedPriceReq: { specialSuggestedPrice: "NA" },
            productSkuWhExtAttrReq: {
              productSkuVolumeReq: { len: d.volumeMm.len, width: d.volumeMm.width, height: d.volumeMm.height },
              productSkuWeightReq: { value: d.weightMg },
              productSkuSensitiveAttrReq: {
                isSensitive: d.isSensitive,
                sensitiveList: d.isSensitive === 1 ? d.sensitiveTypes : [],
              },
              productSkuSensitiveLimitReq: d.maxBatteryCapacityWh
                ? { maxBatteryCapacity: d.maxBatteryCapacityWh }
                : {},
            },
          },
        ],
      },
    ],
    productWhExtAttrReq: {
      outerGoodsUrl: "",
      productOrigin:
        d.region2Id && d.countryShortName === "CN"
          ? { countryShortName: d.countryShortName, region2Id: d.region2Id }
          : { countryShortName: d.countryShortName },
    },
    ...(d.outerPackage
      ? {
          productOuterPackageReq: d.outerPackage.packageShape
            ? { packageShape: d.outerPackage.packageShape, packageType: d.outerPackage.packageType }
            : { packageType: d.outerPackage.packageType },
        }
      : {}),
    ...(pkgTemuUrls.length
      ? {
          productOuterPackageImageReqs: pkgTemuUrls.map((u) => ({ imageUrl: u })),
        }
      : {}),
    ...(d.guideFile
      ? {
          productGuideFileReqs: [
            { fileName: d.guideFile.fileName, pdfMaterialId: d.guideFile.pdfMaterialId, languages: d.guideFile.languages },
          ],
        }
      : {}),
    ...(d.customized
      ? {
          productSaleExtAttrReq: {
            customizedTechnologyReq: {
              firstType: d.customized.firstType,
              twiceType: d.customized.twiceType,
              technologyType: d.customized.technologyType,
            },
          },
        }
      : {}),
  }
}

function idStr(v: unknown, max: number): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v)).slice(0, max)
  if (typeof v === "string" && v.trim()) return v.trim().slice(0, max)
  return null
}

/* ─── 发品记录 ─── */

export interface TemuPublishRecordRow {
  id: string
  templateId: string
  templateName: string
  storeId: string
  storeName: string
  status: "pending" | "success" | "failed"
  productId: string | null
  errorCode: number | null
  errorMsg: string | null
  title: string
  createdAt: string
  /** 提交官方的完整请求体（排障回溯；jsonb 原样透传，可能较大） */
  requestSnapshot: unknown
  /** 官方完整响应（含 accesstoken 回查的 actualMallName） */
  responseSnapshot: unknown
}

export async function listPublishRecordsAction(
  input: { templateId?: string; limit?: number } = {},
): Promise<{ ok: true; rows: TemuPublishRecordRow[] } | { ok: false; error: string }> {
  const q = temuPublishRecordsQuerySchema.parse(input)
  const ctx = await requireEnterpriseContext()
  const { enterpriseId } = getCurrentEnterpriseScope(ctx)
  const where = q.templateId
    ? and(eq(temuPublishRecords.enterpriseId, enterpriseId), eq(temuPublishRecords.templateId, q.templateId))
    : eq(temuPublishRecords.enterpriseId, enterpriseId)
  const rows = await db
    .select({ rec: temuPublishRecords })
    .from(temuPublishRecords)
    .where(where)
    .orderBy(desc(temuPublishRecords.createdAt))
    .limit(q.limit)
  const tplIds = [...new Set(rows.map((r) => r.rec.templateId))]
  const storeIds = [...new Set(rows.map((r) => r.rec.storeId))]
  const [tpls, stores] = await Promise.all([
    tplIds.length
      ? db
          .select({ id: temuPublishTemplates.id, name: temuPublishTemplates.name })
          .from(temuPublishTemplates)
          .where(inArray(temuPublishTemplates.id, tplIds))
      : Promise.resolve([]),
    storeIds.length
      ? db
          .select({ id: temuStores.id, name: temuStores.name })
          .from(temuStores)
          .where(inArray(temuStores.id, storeIds))
      : Promise.resolve([]),
  ])
  const tplMap = new Map(tpls.map((t) => [t.id, t.name]))
  const storeMap = new Map(stores.map((s) => [s.id, s.name]))
  return {
    ok: true,
    rows: rows.map(({ rec }) => ({
      id: rec.id,
      templateId: rec.templateId,
      templateName: tplMap.get(rec.templateId) ?? "（已删除模板）",
      storeId: rec.storeId,
      storeName: storeMap.get(rec.storeId) ?? "（已删除店铺）",
      status: rec.status as TemuPublishRecordRow["status"],
      productId: rec.productId,
      errorCode: rec.errorCode,
      errorMsg: rec.errorMsg,
      title: rec.overrides?.title ?? "",
      createdAt: rec.createdAt.toISOString(),
      requestSnapshot: rec.requestSnapshot ?? null,
      responseSnapshot: rec.responseSnapshot ?? null,
    })),
  }
}
