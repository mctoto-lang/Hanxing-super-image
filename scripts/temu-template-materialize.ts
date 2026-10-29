/* 手动物化 TEMU 发品模板内嵌源（一次性存量迁移，随「根治大载荷」改造引入）：
 * - defaults.imageUrls / dimensionImageUrl / outerPackageImages 中的 data:image/... 项
 *   → 解码存自有存储（category=temu，不过期）→ 替换为 URL；
 * - defaults.guideFile.base64 → 存 .pdf → 置 sourceUrl、删 base64。
 * 之后模板只存 URL，发品/建模板 server action 载荷恒 KB 级（此前 dataUrl/base64
 * 会被生产反向代理 413 拒绝且发品记录无痕）。
 * 幂等可重跑（已物化行自动跳过）。只读库+写存储，不调 TEMU 官方 API。
 * 用法：npx tsx scripts/temu-template-materialize.ts           # dry-run（默认，仅统计）
 *       npx tsx scripts/temu-template-materialize.ts --apply   # 实际写库
 * 生产：docker compose run --rm migrate npx tsx scripts/temu-template-materialize.ts --apply */
try {
  process.loadEnvFile()
} catch {}

const IMAGE_DATA_URL_RE = /^data:(image\/(?:png|jpeg));base64,/

interface GuideFile {
  fileName: string
  pdfMaterialId?: number
  languages: string[]
  sourceUrl?: string
  base64?: string
}

interface Defaults {
  imageUrls: string[]
  dimensionImageUrl?: string
  outerPackageImages?: string[]
  guideFile?: GuideFile
}

async function main() {
  const apply = process.argv.includes("--apply")
  const { db } = await import("../src/db/client")
  const { temuPublishTemplates } = await import("../src/db/schema/temu")
  const { eq } = await import("drizzle-orm")
  const { getStorage } = await import("../src/lib/storage")
  const storage = await getStorage()

  /** dataUrl → 存储对象（temu/ 前缀不过期），返回可访问 URL */
  const storeDataUrl = async (src: string, enterpriseId: string): Promise<string> => {
    const isPdf = src.startsWith("data:application/pdf;base64,")
    const m = IMAGE_DATA_URL_RE.exec(src)
    if (!isPdf && !m) throw new Error(`无法识别的 dataUrl 前缀：${src.slice(0, 40)}`)
    const buf = Buffer.from(src.slice(src.indexOf(",") + 1), "base64")
    if (!isPdf && buf.length > 2 * 1024 * 1024) {
      // 模板 dataUrl 均为选图时浏览器压缩产物（≤2MB）；超限说明数据异常，人工核对
      throw new Error(`存量图 ${buf.length} 字节超过 2MB，请人工核对该模板`)
    }
    const mime = isPdf ? "application/pdf" : (m![1] ?? "image/jpeg")
    const ext = mime === "image/png" ? "png" : isPdf ? "pdf" : "jpg"
    return storage.saveFromBuffer(buf, enterpriseId, ext, "temu")
  }

  /** 列表内 data: 项逐一物化；无 data: 原样返回（引用相等用于变更检测） */
  const materializeList = async (
    list: string[] | undefined,
    enterpriseId: string,
  ): Promise<string[] | undefined> => {
    if (!list?.some((s) => s.startsWith("data:"))) return list
    const out: string[] = []
    for (const src of list) {
      if (!src.startsWith("data:")) {
        out.push(src)
        continue
      }
      const url = await storeDataUrl(src, enterpriseId)
      console.log(`[materialize] 图源 → ${url.slice(0, 100)}`)
      out.push(url)
    }
    return out
  }

  const rows = await db
    .select()
    .from(temuPublishTemplates)
    .where(eq(temuPublishTemplates.status, "active"))
  let touched = 0
  let unchanged = 0
  let failed = 0

  for (const row of rows) {
    const d = row.defaults as Defaults
    try {
      const imageUrls = await materializeList(d.imageUrls, row.enterpriseId)
      const outerPackageImages = await materializeList(d.outerPackageImages, row.enterpriseId)
      let dimensionImageUrl = d.dimensionImageUrl
      if (dimensionImageUrl?.startsWith("data:")) {
        dimensionImageUrl = await storeDataUrl(dimensionImageUrl, row.enterpriseId)
        console.log(`[materialize] 尺寸图 → ${dimensionImageUrl.slice(0, 100)}`)
      }
      let guideFile = d.guideFile
      if (guideFile?.base64) {
        const url = await storeDataUrl(
          `data:application/pdf;base64,${guideFile.base64}`,
          row.enterpriseId,
        )
        guideFile = { ...guideFile, sourceUrl: url }
        delete guideFile.base64
        console.log(`[materialize] 说明书 ${guideFile.fileName} → ${url.slice(0, 100)}`)
      }

      const changed =
        imageUrls !== d.imageUrls ||
        outerPackageImages !== d.outerPackageImages ||
        dimensionImageUrl !== d.dimensionImageUrl ||
        guideFile !== d.guideFile
      if (!changed) {
        unchanged++
        continue
      }
      touched++
      if (apply) {
        await db
          .update(temuPublishTemplates)
          .set({
            defaults: {
              ...d,
              imageUrls: imageUrls ?? [],
              ...(outerPackageImages ? { outerPackageImages } : {}),
              ...(dimensionImageUrl ? { dimensionImageUrl } : {}),
              ...(guideFile ? { guideFile } : {}),
            },
            updatedAt: new Date(),
          })
          .where(eq(temuPublishTemplates.id, row.id))
      } else {
        console.log(`[materialize] （dry-run）模板「${row.name}」将迁移`)
      }
    } catch (err) {
      failed++
      console.error(
        `[materialize] 模板「${row.name}」失败：`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  console.log(
    `[materialize] 完成（${apply ? "APPLY" : "DRY-RUN"}）：迁移 ${touched} 个模板，` +
      `无需迁移 ${unchanged} 个，失败 ${failed} 个` +
      `${apply ? "" : "（dry-run 未写库，确认无误后加 --apply 执行）"}`,
  )
  process.exit(0)
}

void main()
