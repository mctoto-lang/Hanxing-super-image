/**
 * 商品主图 V2 prompt 组装（纯函数，供 "use server" actions 与单测复用）
 */

import {
  getLanguageDef,
  getPlatformDef,
} from "@/lib/product/dictionaries"

/** 模板变量填充：缺失变量替换为空串（对应句自然省略），压缩水平多余空白。
 *  只折叠空格/制表符运行、保留换行——多行变量（{{directionPool}}/{{cards}}）
 *  的清单结构不被压扁。 */
export function fillVars(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

/** 取首个卖点（模板 {{topSellingPoint}} 用） */
export function firstSellingPoint(sellingPoints?: string): string {
  if (!sellingPoints) return ""
  return (
    sellingPoints
      .split(/[\n,，;；、]/)
      .map((s) => s.trim())
      .find(Boolean) ?? ""
  )
}

/** 方向是否属于某子功能作用域（appliesTo 含该 scope；null/undefined 视为不属于，两处池过滤共用） */
export function directionInScope(
  appliesTo: string[] | null | undefined,
  scope: string,
): boolean {
  return (appliesTo ?? []).includes(scope)
}

/**
 * 智能匹配总量规范化（模板软约束的服务端保底）：
 * 已选方向张数总和 < min 时轮转 +1（不超各自上限），> max 时从张数最多者
 * 递减（不低于 1）。返回新数组，不改入参；无法满足时尽力逼近后返回。
 */
export function normalizeSlotCounts<
  T extends { selected: boolean; count: number; maxCount: number },
>(slots: readonly T[], minTotal = 7, maxTotal = 9): T[] {
  const next = slots.map((s) => ({ ...s }))
  const total = () =>
    next.reduce((sum, s) => sum + (s.selected ? s.count : 0), 0)
  while (total() > maxTotal) {
    const target = next
      .filter((s) => s.selected)
      .sort((a, b) => b.count - a.count)
      .find((s) => s.count > 1)
    if (!target) break
    target.count--
  }
  while (total() < minTotal) {
    const capable = next.filter((s) => s.selected && s.count < s.maxCount)
    if (capable.length === 0) break
    for (const s of capable) {
      if (total() >= minTotal) break
      s.count++
    }
  }
  return next
}

/**
 * 主图类方向判定（注入平台主图规范 heroPromptSegment）：
 * isHero 为数据化判定（超管表单「方向类别」选择）；key 集合为存量数据兜底
 * （hero_visual=内置种子 key，baiditu=后台自定义的「白底图」key）
 */
const HERO_DIRECTION_KEYS = new Set(["hero_visual", "baiditu"])

function isHeroDirection(directionKey: string, isHero?: boolean): boolean {
  return isHero === true || HERO_DIRECTION_KEYS.has(directionKey)
}

/** 方向类 prompt 组装（suite/detail/refine 共用）
 *
 * V2.7 全模板化：输出 = fillVars(方向模板, 全量变量)，服务端不再追加任何
 * 固定文案（含用户补充要求——见严格模式）。可用变量见 prompt-vars.ts 的
 * DIRECTION_TEMPLATE_VARS；其中复合变量 {{platformSegment}} 保留主图类
 * 语义（isHero 数据化判定 + 内置 key 兜底，自动拼入平台主图规范），
 * 细粒度变量（{{platformGeneralSegment}} 等）一律为原始字段值。
 * resolved* 为可选的 DB 化配置覆盖（product-config.ts 解析产物）；
 * 不传时回退 dictionaries 常量（单测与旧行为兼容）。
 */
export function buildDirectionPrompt(opts: {
  mode: "suite" | "detail" | "refine"
  platformKey?: string
  languageKey?: string
  promptTemplate: string
  directionKey: string
  /** 白底图类（主图）标记（方向行 isHero；缺省回退 key 集合判定） */
  isHero?: boolean
  baseVars: Record<string, string | undefined>
  smartVars?: Record<string, string | undefined>
  /** 用户补充要求（{{additionalPrompt}} 变量；模板未引用即丢弃） */
  additionalPrompt?: string
  /** DB 平台定义（缺省回退 getPlatformDef） */
  resolvedPlatform?: {
    key?: string | null
    label?: string | null
    heroPromptSegment?: string | null
    generalPromptSegment?: string | null
  } | null
  /** DB 语言定义（缺省回退 getLanguageDef） */
  resolvedLanguage?: {
    key?: string | null
    label?: string | null
    outputName?: string | null
    imageDirective?: string | null
  } | null
}): string {
  const platform = opts.resolvedPlatform
    ? {
        key: opts.resolvedPlatform.key ?? undefined,
        label: opts.resolvedPlatform.label ?? undefined,
        generalPromptSegment:
          opts.resolvedPlatform.generalPromptSegment ?? undefined,
        heroPromptSegment: opts.resolvedPlatform.heroPromptSegment ?? undefined,
      }
    : opts.platformKey
      ? (getPlatformDef(opts.platformKey) ?? undefined)
      : undefined
  const lang = opts.resolvedLanguage
    ? {
        outputName: opts.resolvedLanguage.outputName ?? undefined,
        imageDirective: opts.resolvedLanguage.imageDirective ?? undefined,
      }
    : opts.languageKey
      ? (getLanguageDef(opts.languageKey) ?? undefined)
      : undefined
  const hero = isHeroDirection(opts.directionKey, opts.isHero)
  // 平台规范段 = 通用偏好 +（主图类方向）平台主图规范
  const platformSegment = [
    platform?.generalPromptSegment,
    hero ? platform?.heroPromptSegment : null,
  ]
    .filter(Boolean)
    .join(" ")
  return fillVars(opts.promptTemplate, {
    platformKey: opts.platformKey ?? opts.resolvedPlatform?.key ?? undefined,
    platformLabel: platform?.label,
    outputLanguage: lang?.outputName,
    platformSegment,
    platformGeneralSegment: platform?.generalPromptSegment,
    platformHeroSegment: platform?.heroPromptSegment,
    languageDirective: lang?.imageDirective,
    additionalPrompt: opts.additionalPrompt?.trim() || undefined,
    ...opts.baseVars,
    ...opts.smartVars,
  })
}

/**
 * 精修多选合并：全部选中项模板剥掉 {{additionalPrompt}} 变量后按序换行拼接为
 * 复合指令；用户补充要求以单个 {{additionalPrompt}} 尾段注入（严格模式：未填
 * 不注入——fillVars 未引用变量即丢弃）。
 */
export function mergeRefineTemplates(
  templates: string[],
  additionalPrompt?: string | null,
): string {
  const segments = templates
    .map((t) => t.replace(/\{\{\s*additionalPrompt\s*\}\}/g, "").trim())
    .filter(Boolean)
  const extra = additionalPrompt?.trim()
  return [...segments, extra ? "{{additionalPrompt}}" : ""]
    .filter(Boolean)
    .join("\n")
}

/** 智能匹配可用模块池清单（喂 {{directionPool}} 变量的多行文本；
 *  行格式与池数据序列化，属数据格式化而非 prompt 拼接） */
export function formatDirectionPool(
  rows: Array<{
    key: string
    name: string
    description?: string | null
    maxCount?: number | null
    isHero?: boolean | null
  }>,
): string {
  return rows
    .map(
      (p) =>
        `- ${p.key}（${p.name}${p.description ? `：${p.description}` : ""}，maxCount=${p.maxCount ?? 1}${p.isHero ? "，【主图类】" : ""}）`,
    )
    .join("\n")
}

/** 出卡方向清单（喂 {{cards}} 变量的多行文本：编号 + 名称/描述 + 智能匹配定制） */
export function formatCardList(
  cards: Array<{
    name: string
    description?: string | null
    vars?: {
      angle?: string
      focus?: string
      copyHint?: string
      target?: string
    } | null
  }>,
): string {
  const lines: string[] = []
  cards.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.name}${c.description ? `（${c.description}）` : ""}`)
    const v = c.vars
    if (v && (v.angle || v.focus || v.copyHint || v.target)) {
      const hints = [
        v.angle && `机位=${v.angle}`,
        v.focus && `主体=${v.focus}`,
        v.copyHint && `图上文案=${v.copyHint}`,
        v.target && `特写=${v.target}`,
      ].filter(Boolean)
      lines.push(`   定制指导：${hints.join("；")}`)
    }
  })
  return lines.join("\n")
}

/** 商品信息编号文本块解析产物（模板变量来源） */
export interface ProductBriefVars {
  productName?: string
  sellingPoints?: string
  topSellingPoint?: string
  targetAudience?: string
}

/** 编号行匹配（标题独占一行，内容在后续行）：「1.商品名称：」/「1、商品名称」 */
const BRIEF_HEADING_RE = /^\s*(\d+)\s*[.、．]\s*([^：:\n]{1,20})\s*[：:]?\s*$/
/** 编号同行匹配（内容跟在冒号后）：「1.商品名称：xxx」 */
const BRIEF_INLINE_RE = /^\s*(\d+)\s*[.、．]\s*([^：:\n]{1,20})\s*[：:]\s*(.+)$/

/**
 * 解析合并输入框的商品信息文本（AI 帮写的编号格式契约）：
 * 1.商品名称 2.核心卖点 3.适用人群 4.使用场景 5.规格参数 …
 *
 * - 名称/人群映射到 productName/targetAudience；
 * - 核心卖点位卖点主体，其余编号节（使用场景/规格参数/画面建议…）追加其后保留信息；
 * - 无编号结构时整段作为 sellingPoints（兼容手写自由文本）。
 */
export function parseProductBrief(text: string | undefined | null): ProductBriefVars {
  const trimmed = (text ?? "").trim()
  if (!trimmed) return {}

  const sections: { title: string; body: string[] }[] = []
  const preamble: string[] = []
  let current: { title: string; body: string[] } | null = null
  for (const line of trimmed.split(/\r?\n/)) {
    const heading = line.match(BRIEF_HEADING_RE)
    if (heading) {
      current = { title: heading[2]!.trim(), body: [] }
      sections.push(current)
      continue
    }
    const inline = line.match(BRIEF_INLINE_RE)
    if (inline) {
      current = { title: inline[2]!.trim(), body: [inline[3]!] }
      sections.push(current)
      continue
    }
    if (current) current.body.push(line)
    else preamble.push(line)
  }
  if (sections.length === 0) {
    return {
      sellingPoints: trimmed,
      topSellingPoint: firstSellingPoint(trimmed) || undefined,
    }
  }

  const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase()
  const pick = (keywords: string[]) =>
    sections.find((s) => keywords.some((k) => normalize(s.title).includes(k)))

  const nameSec = pick(["名称", "品名", "name"])
  const audienceSec = pick(["人群", "受众", "audience"])
  const sellingSec = pick(["卖点", "selling"])
  const cleanLines = (body: string[]) =>
    body.map((l) => l.trim().replace(/^[-•·]\s*/, "").trim()).filter(Boolean)

  const extraParts: string[] = []
  for (const sec of sections) {
    if (sec === nameSec || sec === audienceSec || sec === sellingSec) continue
    const body = cleanLines(sec.body)
    if (body.length > 0) extraParts.push(`${sec.title}：${body.join("；")}`)
  }
  const preambleText = preamble.map((l) => l.trim()).filter(Boolean)
  if (preambleText.length > 0) extraParts.unshift(preambleText.join("；"))

  const sellingBody = sellingSec ? cleanLines(sellingSec.body) : []
  const sellingPoints = [
    ...sellingBody,
    ...extraParts.map((p) => `- ${p}`),
  ].join("\n")

  const name = nameSec ? cleanLines(nameSec.body).join(" ") : undefined
  const audience = audienceSec ? cleanLines(audienceSec.body).join(" ") : undefined

  const vars: ProductBriefVars = {}
  if (name) vars.productName = name
  if (audience) vars.targetAudience = audience
  if (sellingPoints) {
    vars.sellingPoints = sellingPoints
    vars.topSellingPoint = firstSellingPoint(sellingPoints) || undefined
  }
  return vars
}
