import { z } from "zod"

/**
 * Temu 面板 zod schemas
 *
 * 面板查询/店铺管理系列为 Server Action 入参（企业隔离在 Action 内强制）。
 * 历史的插件上报契约（ingest 系列）随插件链路移除。
 */

// ---------- 面板查询（URL 驱动参数） ----------

export const temuTabSchema = z.enum([
  "overview",
  "products",
  "publish",
  "ads",
  "price",
  "purchase",
  "qc",
  "stores",
])
export type TemuTab = z.infer<typeof temuTabSchema>

export const temuListQuerySchema = z.object({
  tab: temuTabSchema.default("overview"),
  /** 店铺筛选（空字符串 = 全部店铺） */
  store: z.string().uuid().optional(),
  q: z.string().max(100).optional(),
  /** 在售筛选（商品信息页：on=在售 skcStatus=11，off=不在售） */
  sale: z.enum(["on", "off"]).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  /** 广告窗口天数（广告推广页 ?range=；action 内收敛为 7|30） */
  range: z.coerce.number().int().min(1).max(90).optional(),
  /** 商品排序：listed 上架时间新→旧（默认）/ today 今日销量 / last7 七日销量 /
   *  sn 货号 B 后数字自然序小→大（空值最上） */
  sort: z.enum(["listed", "today", "last7", "sn"]).optional(),
})
export type TemuListQuery = z.infer<typeof temuListQuerySchema>

// ---------- 店铺管理（企业管理员） ----------

export const createTemuStoreSchema = z.object({
  name: z.string().min(1, "请输入店铺名称").max(100),
  mallId: z.string().max(64).optional(),
  mallName: z.string().max(100).optional(),
})
export type CreateTemuStoreInput = z.infer<typeof createTemuStoreSchema>

/** 编辑店铺（名称 / mall 绑定）：mallId 用于官方 API 授权信息对齐
 *  （accesstoken.info 回填的是 52~56 字符 base64 uniqueId，列宽 64——上限 32 会拒掉自动回填值） */
export const updateTemuStoreSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1, "请输入店铺名称").max(100).optional(),
  mallId: z.string().max(64).nullable().optional(),
  mallName: z.string().max(100).nullable().optional(),
})
export type UpdateTemuStoreInput = z.infer<typeof updateTemuStoreSchema>

/** 录入/更新店铺官方 API access_token */
export const setTemuStoreTokenSchema = z.object({
  id: z.string().uuid(),
  accessToken: z.string().min(16).max(128),
})

export const toggleTemuStoreSchema = z.object({
  id: z.string().uuid(),
  enabled: z.boolean(),
})

/** 定时同步开关（不影响手动同步） */
export const toggleTemuStoreSyncSchema = z.object({
  id: z.string().uuid(),
  syncEnabled: z.boolean(),
})

export const deleteTemuStoreSchema = z.object({ id: z.string().uuid() })

// ---------- 核价/调价工作台（全托，实时拉取不落库） ----------

/** 核价单状态（bg.price.review.page.query orderStatus） */
export const temuPriceReviewStatusSchema = z
  .enum(["pending", "supplier", "passed", "rejected", "discarded", "syncing"])
export type TemuPriceReviewStatus = z.infer<typeof temuPriceReviewStatusSchema>

export const temuPriceReviewQuerySchema = z.object({
  store: z.string().uuid(),
  status: temuPriceReviewStatusSchema.optional(),
})

/** 拒绝核价建议价（bg.price.review.reject）：按 SKU 给新申报价 + 原因列表 */
export const temuPriceReviewRejectSchema = z.object({
  store: z.string().uuid(),
  orderId: z.coerce.number().int().positive(),
  /** SKU 新申报价（分） */
  priceItemList: z
    .array(
      z.object({
        productSkuId: z.coerce.number().int().positive(),
        price: z.coerce.number().int().min(1),
      }),
    )
    .min(1)
    .max(100),
  /** 重新报价原因（componentList，官方 1~20 条；type 0材质/1功能/2其他/3品类/4外观/5版型/6图案/7规格尺寸/8品牌） */
  reasons: z
    .array(
      z.object({
        type: z.coerce.number().int().min(0).max(8),
        reason: z.string().min(1).max(200),
      }),
    )
    .min(1)
    .max(20),
})

/** 调价单状态（bg.full.adjust.price.page.query status） */
export const temuAdjustOrderStatusSchema = z.enum(["pending", "supplier", "success", "failed"])

export const temuAdjustOrderQuerySchema = z.object({
  store: z.string().uuid(),
  status: temuAdjustOrderStatusSchema,
})

export const temuAdjustApproveSchema = z.object({
  store: z.string().uuid(),
  priceOrderSns: z.array(z.string().min(1).max(64)).min(1).max(50),
})

// ---------- 广告工作台（bg.glo.searchrec.ad.*，实时拉取；注册表 temu_ad） ----------

/** 创建广告商品候选查询（temu_product 同步列表 + goods.create.query 可投性合并） */
export const temuAdProductsQuerySchema = z.object({
  store: z.string().uuid(),
  /** 商品名/货号模糊搜索 */
  q: z.string().trim().max(64).optional(),
})

/** 创建广告（ad.create；budget 分，目标 ROAS 数值口径待官方确认） */
export const temuAdCreateSchema = z.object({
  store: z.string().uuid(),
  items: z
    .array(
      z.object({
        productId: z.string().trim().min(1).max(32),
        /** 日预算（分） */
        budget: z.coerce.number().int().min(1).max(100_000_000),
        /** 目标 ROAS（如 3.5） */
        roas: z.coerce.number().min(0.01).max(1000),
      }),
    )
    .min(1)
    .max(20),
})

/** 广告修改（ad.modify status：2 暂停 / 3 开启 / 4 改预算 / 5 改 ROAS） */
export const temuAdModifySchema = z.object({
  store: z.string().uuid(),
  productId: z.string().trim().min(1).max(32),
  action: z.enum(["pause", "open", "budget", "roas"]),
  /** action=budget 必填（分） */
  budget: z.coerce.number().int().min(1).max(100_000_000).optional(),
  /** action=roas 必填 */
  roas: z.coerce.number().min(0.01).max(1000).optional(),
})


// ---------- 模板化发品（M2：企业级刊登模板，bg.glo.goods.add 实测口径见 docs §8.12） ----------

/** 类目查询（category.match searchText / cats.get parentCatId 钻取） */
export const temuCategoryQuerySchema = z.object({
  /** 关键词匹配（match.searchText ≤200）与钻取二选一 */
  keyword: z.string().trim().min(1).max(200).optional(),
  parentCatId: z.coerce.number().int().min(0).optional(),
})

/** 属性模板查询（叶子类目） */
export const temuAttrTemplateQuerySchema = z.object({
  catId: z.coerce.number().int().positive(),
})

/** 模板属性选定值（attrs.get 驱动，父子联动由向导保证） */
export const temuTemplateAttrSchema = z.object({
  templatePid: z.coerce.number().int(),
  pid: z.coerce.number().int(),
  refPid: z.coerce.number().int(),
  propName: z.string().trim().min(1).max(100),
  vid: z.coerce.number().int(),
  propValue: z.string().trim().min(1).max(500),
  valueUnit: z.string().max(50),
  numberInputValue: z.string().max(200).optional(),
})

/** 自建规格定义（parentspec.get 父规格 + spec.create 值名；specId 店铺级不落模板） */
export const temuTemplateSpecSchema = z.object({
  parentSpecId: z.coerce.number().int().positive(),
  parentSpecName: z.string().trim().min(1).max(50),
  specName: z.string().trim().min(1).max(100),
})

/** 图源数组口径：http(s) URL 或浏览器压缩 dataUrl（模板存源，发品按店上传） */
export const IMAGE_SOURCE = z.union([
  z.string().url().max(1000),
  z.string().max(8_000_000).regex(/^data:image\/(?:png|jpeg);base64,/),
])
const IMAGE_SOURCE_ARRAY = z.array(IMAGE_SOURCE)

/** 模板默认层（锁定骨架 + 发品可覆盖项） */
export const temuTemplateDefaultsSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    /** 素材图源（可为空；发品时按目标店铺上传官方图床并校验 1:1 ≥800×800 ≤2M）：
     *  http(s) 图库/外链 URL 或浏览器压缩产物 data:image/...；图[0] 兼作素材图/SKU 预览/缩略。
     *  非服饰轮播图官方最少 5 张（实测 1000002）——在发品预检拦截 */
    imageUrls: IMAGE_SOURCE_ARRAY.max(20),
    declaredPriceFen: z.coerce.number().int().min(1).max(100_000_000),
    extCode: z
      .string()
      .trim()
      .max(64)
      .regex(/^[A-Za-z0-9._-]*$/, "货号仅允许字母、数字与标点（6000018）")
      .default(""),
    countryShortName: z.string().trim().length(2),
    /** 中国省级枚举 id（docs §13.1，如 广东 43000000000006；仅 CN 下发） */
    region2Id: z.coerce.number().int().positive().max(1e15).optional(),
    weightMg: z.coerce.number().int().min(1).max(2_000_000_000),
    volumeMm: z.object({
      len: z.coerce.number().int().min(1).max(2_000_000),
      width: z.coerce.number().int().min(1).max(2_000_000),
      height: z.coerce.number().int().min(1).max(2_000_000),
    }),
    isSensitive: z.union([z.literal(0), z.literal(1)]),
    sensitiveTypes: z.array(z.coerce.number().int().positive()).max(8).default([]),
    maxBatteryCapacityWh: z.coerce.number().int().min(1).max(1_000_000).optional(),
    // 外包装（形状 1 长方体/2 圆柱体，"其他不规则"=不提交形状；类型 0/1/2 按卖家中心顺序：硬包装/软包装+硬物/软包装+软物）
    outerPackage: z
      .object({
        packageShape: z.union([z.literal(1), z.literal(2)]).optional(),
        packageType: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      })
      .optional(),
    // 外包装图源（正拍/侧拍/俯拍槽位；发品时按目标店上传，≥1 张按槽位顺序提交）
    outerPackageImages: IMAGE_SOURCE_ARRAY.max(3).optional(),
    // 尺寸图源（可选；发品时按目标店上传后固定插入轮播第 2 张——卖家中心页面口径，
    // API 实测不校验位置（§8.15），按页面口径固定最稳）
    dimensionImageUrl: IMAGE_SOURCE.optional(),
    // 电子说明书（存 PDF 源；发品时按目标店铺 instructions.upload 换 pdfId。pdfMaterialId 兼容旧模板）
    guideFile: z
      .object({
        fileName: z.string().trim().min(1).max(200),
        /** 兼容旧模板（无 base64 源时发品用存量 id，跨店可能报错） */
        pdfMaterialId: z.coerce.number().int().positive().optional(),
        languages: z.array(z.string().trim().min(2).max(10)).min(1).max(10).default(["en"]),
        /** PDF 源（base64，保存模板时不再调官方接口；列表响应剥离） */
        base64: z.string().min(10).max(20_000_000).optional(),
      })
      .refine((g) => Boolean(g.base64 ?? g.pdfMaterialId), {
        message: "缺少 PDF 源（请重新选择 PDF 文件）",
        path: ["base64"],
      })
      .optional(),
    // 定制商品工艺（firstType/twiceType 枚举见 docs §13.6；technologyType 官方未文档化，实测 1 可用）
    customized: z
      .object({
        firstType: z.coerce.number().int().min(10001).max(10006),
        twiceType: z.array(z.coerce.number().int().min(20001).max(20040)).min(1).max(20),
        technologyType: z.coerce.number().int().min(1).max(10),
      })
      .optional(),
    // SKU 分类/多件装（不配=单品 1 件）
    skuPack: z
      .object({
        skuClassification: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        numberOfPieces: z.coerce.number().int().min(1).max(999),
        pieceUnitCode: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      })
      .optional(),
  })
  .refine((d) => d.volumeMm.len >= d.volumeMm.width && d.volumeMm.width >= d.volumeMm.height, {
    message: "体积须满足最长边 ≥ 次长边 ≥ 最短边（2000044）",
    path: ["volumeMm"],
  })
  .refine((d) => d.isSensitive === 0 || d.sensitiveTypes.length > 0, {
    message: "敏感商品须选择敏感类型",
    path: ["sensitiveTypes"],
  })
  .refine((d) => d.countryShortName !== "CN" || d.region2Id != null, {
    message: "中国产地必须选择省份（官方实测必填）",
    path: ["region2Id"],
  })

/** 模板创建/更新（锁定层：类目链 + 属性 + 规格 + 默认层骨架） */
export const temuPublishTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** 1~6 级完整链，末级必须叶子 */
  categoryChain: z
    .array(
      z.object({
        catId: z.coerce.number().int().positive(),
        catName: z.string().trim().min(1).max(100),
        isLeaf: z.boolean(),
      }),
    )
    .min(1)
    .max(6)
    .refine((c) => c[c.length - 1]?.isLeaf === true, { message: "最后一级必须是叶子类目" }),
  attributes: z.array(temuTemplateAttrSchema).max(40),
  specConfig: temuTemplateSpecSchema,
  defaults: temuTemplateDefaultsSchema,
})

export const temuPublishTemplateUpdateSchema = temuPublishTemplateSchema.extend({
  id: z.string().uuid(),
})

/** 图片上传（imageUrl 外链由服务端拉取；imageDataUrl 为浏览器压缩后的直传数据） */
export const temuPublishImageSchema = z
  .object({
    imageUrl: z.string().url().max(1000).optional(),
    /** data:image/(png|jpeg);base64,...（>2MB 浏览器压缩后的产物，服务端免拉取） */
    imageDataUrl: z
      .string()
      .max(8_000_000)
      .regex(/^data:image\/(?:png|jpeg);base64,/)
      .optional(),
  })
  .refine((v) => Boolean(v.imageUrl ?? v.imageDataUrl), { message: "缺少图片来源" })

/** 发品（模板 + 店铺 + 覆盖默认层） */
export const temuPublishActionSchema = z.object({
  templateId: z.string().uuid(),
  storeId: z.string().uuid(),
  overrides: z
    .object({
      title: z.string().trim().min(1).max(500).optional(),
      imageUrls: IMAGE_SOURCE_ARRAY.max(20).optional(),
      /** 尺寸图覆盖（不传=用模板 dimensionImageUrl；发品时插入轮播第 2 张） */
      dimensionImageUrl: IMAGE_SOURCE.optional(),
      declaredPriceFen: z.coerce.number().int().min(1).max(100_000_000).optional(),
      extCode: z.string().trim().max(64).optional(),
    })
    .default({}),
})

/** 发品记录查询 */
export const temuPublishRecordsQuerySchema = z.object({
  templateId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/** 电子说明书 PDF 上传（base64 → bg.glo.goods.instructions.upload → pdfId） */
export const temuPublishGuideFileSchema = z.object({
  base64File: z.string().min(10).max(20_000_000),
  fileName: z.string().trim().min(1).max(200),
})

/** 官方高清图压缩（bg.glo.picturecompression.get——仅接受官方图床 img.kwcdn.com URL，实测 §8.14） */
export const temuImageCompressSchema = z.object({
  urls: z.array(z.string().url().max(1000)).min(1).max(10),
})

/** 尺寸图校验（bg.algo.dimension.image.check 两段式异步，参考性校验不阻断发品） */
export const temuDimensionCheckSchema = z.object({
  imageUrl: z.string().url().max(1000),
})

// ---------- 备货单（M5-A 履约，实时拉取不落库） ----------

/** 备货单状态预设（statusList 组合；状态机 0-10 见 docs §8.13） */
export const temuPurchaseStatusSchema = z.enum(["todo", "shipped", "closed", "all"])

export const temuPurchaseQuerySchema = z.object({
  store: z.string().uuid(),
  status: temuPurchaseStatusSchema.default("todo"),
})

/** 批量取消备货单（bg.purchaseorder.cancel：仅待接单等早期状态可取消） */
export const temuPurchaseCancelSchema = z.object({
  store: z.string().uuid(),
  subPurchaseOrderSns: z.array(z.string().min(1).max(64)).min(1).max(50),
})

/** 可申报备货商品查询（本地商品池 join 最新销售行；canPurchase 来自 salesv2 priceDetail） */
export const temuStockableQuerySchema = z.object({
  store: z.string().uuid(),
  q: z.string().trim().max(120).optional(),
  /** 默认只看可备货（salesv2 canPurchase 任一 SKU 为 true） */
  onlyCanPurchase: z.coerce.boolean().default(true),
})

/** 批量申报备货（逐项调 bg.purchaseorder.apply；数量为每 SKU 申报量，上限以官方错误透传为准） */
export const temuStockApplyBatchSchema = z.object({
  store: z.string().uuid(),
  items: z
    .array(
      z.object({
        productSkcId: z.coerce.number().int().positive(),
        productName: z.string().trim().max(500).optional(),
        skuIds: z.array(z.string().min(1).max(32)).min(1).max(50),
        quantity: z.coerce.number().int().min(1).max(100_000),
      }),
    )
    .min(1)
    .max(20),
})

/** 自动备货单链接（apply 大数值钓官方上限 → SKU 级按最大量备满；dryRun=试跑只探测不申报） */
export const temuAutoStockSchema = z.object({
  store: z.string().uuid(),
  productSkcId: z.coerce.number().int().positive(),
  productName: z.string().trim().max(500).optional(),
  skuIds: z.array(z.string().min(1).max(32)).min(1).max(50),
  /** 最低申请备货量（SKU 级门槛：上限 ≥ 该值才申报） */
  minQuantity: z.coerce.number().int().min(1).max(100_000),
  /** 探测用大数值（官方错误文案应返回真实上限） */
  probeQuantity: z.coerce.number().int().min(1).max(100_000).default(100_000),
  dryRun: z.boolean().default(false),
})
