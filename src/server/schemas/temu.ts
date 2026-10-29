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
  "ship",
  "return",
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

// ---------- 发货工作台（本地落库查询 + 官方写操作） ----------

export const temuShipListQuerySchema = z.object({
  store: z.string().uuid(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** 状态预设：pending 待装箱(0) / shipping 待仓库收货(1) / done 已收货入库(2,3) /
   *  partial 部分收货(6) / closed 退货取消(4,5) / all */
  statusPreset: z.enum(["pending", "shipping", "done", "partial", "closed", "all"]).default("all"),
  /** 货号（skcExtCode 精确） */
  skcExtCode: z.string().max(64).optional(),
  subPurchaseOrderSn: z.string().max(64).optional(),
  deliveryOrderSn: z.string().max(64).optional(),
  /** 实时核对：按当前页单号回查官方 shiporderv2 并落库；官方已移除的单本地置为已取消 */
  fresh: z.boolean().optional(),
})
export type TemuShipListQuery = z.infer<typeof temuShipListQuerySchema>

// ---------- 发货五步向导（批次二写侧） ----------

export const temuShipStagingQuerySchema = z.object({
  store: z.string().uuid(),
  /** 备货单号筛选；支持逗号分隔多单号（创建发货单前预检用），映射官方 subPurchaseOrderSnList。
   *  上限 2048：预检需一次性带上全部勾选单（单号约 19 字符，约容百单），256 会静默截断批量预检 */
  subPurchaseOrderSn: z.string().max(2048).optional(),
  skcExtCode: z.string().max(64).optional(),
  /** SKC（productSkcId）筛选，映射官方 productSkcIdList */
  skcId: z.string().max(64).optional(),
  /** 跳过 30s 缓存强制实时（创建发货单前预检必须实时） */
  fresh: z.boolean().optional(),
})
export type TemuShipStagingQuery = z.infer<typeof temuShipStagingQuerySchema>

export const temuShipStagingAddSchema = z.object({
  store: z.string().uuid(),
  subPurchaseOrderSns: z.array(z.string().min(1).max(64)).min(1).max(50),
})
export type TemuShipStagingAddInput = z.infer<typeof temuShipStagingAddSchema>

/** 打包标签（箱唛）打印直出：boxmarkinfo.get + return_data_key → 官方打印页（链接 10min 单次有效） */
export const temuShipBoxMarkPrintSchema = z.object({
  store: z.string().uuid(),
  deliveryOrderSns: z.array(z.string().min(1).max(64)).min(1).max(50),
})
export type TemuShipBoxMarkPrintQuery = z.infer<typeof temuShipBoxMarkPrintSchema>

/** 商品条码打印直出（labelv2.get + return_data_key → 官方打印页，同 10min 单次有效口径）；
 *  按 SKC 维度取条码（发货台/发货单列表行均持有 productSkcId） */
export const temuShipBarcodePrintSchema = z.object({
  store: z.string().uuid(),
  productSkcIds: z.array(z.number().int().positive()).min(1).max(50),
})
export type TemuShipBarcodePrintQuery = z.infer<typeof temuShipBarcodePrintSchema>

/** 发货总体积官方预估（predict.volume.get，出参 predictVolume 字符串，单位立方米）；
 *  供 logisticsmatch 的 predictVolume 与 packing.send 的 predictPackageVolume 自动回填 */
export const temuShipPredictVolumeQuerySchema = z.object({
  store: z.string().uuid(),
  deliveryOrderSns: z.array(z.string().min(1).max(64)).min(1).max(50),
})
export type TemuShipPredictVolumeQuery = z.infer<typeof temuShipPredictVolumeQuerySchema>

export const temuShipReceiveAddressQuerySchema = z.object({
  store: z.string().uuid(),
  subPurchaseOrderSns: z.array(z.string().min(1).max(64)).min(1).max(50),
})
export type TemuShipReceiveAddressQuery = z.infer<typeof temuShipReceiveAddressQuerySchema>

/** 卖家发货地址创建（mall.address.add；省市区 Code+Name 都必填，官方口径） */
export const temuShipMallAddressCreateSchema = z.object({
  store: z.string().uuid(),
  addressLabel: z.string().min(1).max(60),
  contactPersonName: z.string().min(1).max(60),
  contactPersonPhone: z.string().min(5).max(32),
  provinceCode: z.number().int(),
  provinceName: z.string().min(1).max(60),
  cityCode: z.number().int(),
  cityName: z.string().min(1).max(60),
  districtCode: z.number().int(),
  districtName: z.string().min(1).max(60),
  addressDetail: z.string().min(1).max(200),
  /** 仓库类型/面积类型（官方必填枚举，前端用 Select 传码值） */
  warehouseType: z.number().int(),
  warehouseAreaType: z.number().int(),
})
export type TemuShipMallAddressCreateInput = z.infer<typeof temuShipMallAddressCreateSchema>

/** 发货单创建（shiporderv3.create 三级嵌套）；superRefine：每单每 SKU 分箱合计 = 发货数 */
export const temuShipCreateOrderSchema = z.object({
  store: z.string().uuid(),
  groups: z
    .array(
      z.object({
        subWarehouseId: z.number().int(),
        receiveAddressInfo: z.object({
          receiverName: z.string().max(120),
          phone: z.string().max(32),
          provinceName: z.string().max(60),
          provinceCode: z.number().int(),
          cityName: z.string().max(60),
          cityCode: z.number().int(),
          districtName: z.string().max(60),
          districtCode: z.number().int(),
          detailAddress: z.string().max(300),
        }),
        deliveryAddressId: z.number().int(),
        orders: z
          .array(
            z.object({
              subPurchaseOrderSn: z.string().min(1).max(64),
              deliverOrderDetailInfos: z
                .array(
                  z.object({
                    productSkuId: z.number().int(),
                    deliverSkuNum: z.number().int().min(1).max(1_000_000),
                  }),
                )
                .min(1),
              packageInfos: z
                .array(
                  z.object({
                    packageDetailSaveInfos: z
                      .array(
                        z.object({
                          productSkuId: z.number().int(),
                          skuNum: z.number().int().min(1).max(1_000_000),
                        }),
                      )
                      .min(1),
                  }),
                )
                .min(1)
                .max(10),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
})
export type TemuShipCreateOrderInput = z.infer<typeof temuShipCreateOrderSchema>

export const temuShipPackingMatchSchema = z.object({
  store: z.string().uuid(),
  deliveryOrderSns: z.array(z.string().min(1).max(64)).min(1).max(50),
})
export type TemuShipPackingMatchInput = z.infer<typeof temuShipPackingMatchSchema>

/** 平台推荐物流（logisticsmatch 官方六必填） */
export const temuShipLogisticsMatchSchema = z.object({
  store: z.string().uuid(),
  deliveryOrderSns: z.array(z.string().min(1).max(64)).min(1).max(50),
  receiveAddressInfo: z.object({
    receiverName: z.string().max(120),
    phone: z.string().max(32),
    provinceName: z.string().max(60),
    provinceCode: z.number().int(),
    cityName: z.string().max(60),
    cityCode: z.number().int(),
    districtName: z.string().max(60),
    districtCode: z.number().int(),
    detailAddress: z.string().max(300),
  }),
  deliveryAddressId: z.number().int(),
  predictTotalPackageWeight: z.number().int().min(1000),
  subWarehouseId: z.number().int(),
  totalPackageNum: z.number().int().min(1),
  predictVolume: z.string().max(32).optional(),
})
export type TemuShipLogisticsMatchInput = z.infer<typeof temuShipLogisticsMatchSchema>

/** 装箱发货（packing.send 三方式 discriminatedUnion）。
 *  方式 2 平台推荐：predictTotalPackageWeight 官方要求 ≥1kg 且整千克 */
const shipSkuSelfDelivery = z.object({
  deliverMethod: z.literal(1),
  driverName: z.string().min(1).max(60),
  plateNumber: z.string().min(1).max(20),
  expressPackageNum: z.number().int().min(1),
})
const shipSkuThirdPartyDelivery = z
  .object({
    deliverMethod: z.literal(2),
    expressCompanyId: z.number().int(),
    predictTotalPackageWeight: z
      .number()
      .int()
      .min(1000)
      .refine((v) => v % 1000 === 0, { message: "预估总重量须为整千克（克数须为 1000 的倍数）" }),
    /** 预约取货时间：channelScheduleTimeList 原值透传（epoch 毫秒，格式官方未实证） */
    expectPickUpGoodsTime: z.number().int().optional(),
    /** 揽收方式 0 上门揽收（默认）/ 1 送网点；送网点时自送网点四件套必传（官方口径） */
    pickupMethod: z.number().int().min(0).max(1).optional(),
    predictId: z.number().int().optional(),
    expressPackageNum: z.number().int().min(1),
    selfDeliverSitePhone: z.string().max(32).optional(),
    selfDeliverSiteAddress: z.string().max(200).optional(),
    selfDeliverSiteUserCode: z.string().max(64).optional(),
    selfDeliverSiteCompanyCode: z.string().max(64).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.pickupMethod === 1) {
      const required: Array<keyof typeof d> = [
        "selfDeliverSitePhone",
        "selfDeliverSiteAddress",
        "selfDeliverSiteUserCode",
        "selfDeliverSiteCompanyCode",
      ]
      for (const k of required) {
        if (!d[k]) ctx.addIssue({ code: "custom", message: `送网点方式必填 ${k}` })
      }
    }
  })
const shipSkuThirdExpress = z.object({
  deliverMethod: z.literal(3),
  expressCompanyId: z.number().int(),
  expressCompanyName: z.string().min(1).max(120),
  expressDeliverySn: z.string().min(1).max(64),
  expressPackageNum: z.number().int().min(1),
})

export const temuShipPackingSendSchema = z.discriminatedUnion("deliverMethod", [
  shipSkuSelfDelivery,
  shipSkuThirdPartyDelivery,
  shipSkuThirdExpress,
])
export type TemuShipPackingSendInput = z.infer<typeof temuShipPackingSendSchema>

export const temuShipSendActionSchema = z.object({
  store: z.string().uuid(),
  deliveryOrderSns: z.array(z.string().min(1).max(64)).min(1).max(50),
  deliveryAddressId: z.number().int(),
  predictPackageVolume: z.string().max(32).optional(),
  payload: temuShipPackingSendSchema,
})
export type TemuShipSendActionInput = z.infer<typeof temuShipSendActionSchema>

export const temuShipCancelSchema = z.object({
  store: z.string().uuid(),
  deliveryOrderSn: z.string().min(1).max(64),
})
export type TemuShipCancelInput = z.infer<typeof temuShipCancelSchema>

/** 调整包裹（package.edit）：与创建同款「每 SKU 分箱合计 = 发货数」校验 */
export const temuShipPackageEditSchema = z.object({
  store: z.string().uuid(),
  deliveryOrderSn: z.string().min(1).max(64),
  deliverOrderDetailInfos: z
    .array(
      z.object({
        productSkuId: z.number().int(),
        deliverSkuNum: z.number().int().min(1).max(1_000_000),
      }),
    )
    .min(1),
  packageInfos: z
    .array(
      z.object({
        packageDetailSaveInfos: z
          .array(z.object({ productSkuId: z.number().int(), skuNum: z.number().int().min(1) }))
          .min(1),
      }),
    )
    .min(1)
    .max(10),
})
export type TemuShipPackageEditInput = z.infer<typeof temuShipPackageEditSchema>

/** 修改物流（logistics.change by expressBatchSn，三选一同 packing.send） */
export const temuShipLogisticsChangeSchema = z.object({
  store: z.string().uuid(),
  expressBatchSn: z.string().min(1).max(64),
  deliveryAddressId: z.number().int(),
  payload: temuShipPackingSendSchema,
})
export type TemuShipLogisticsChangeInput = z.infer<typeof temuShipLogisticsChangeSchema>

export const temuShipExpressNoValidateSchema = z.object({
  store: z.string().uuid(),
  shippingId: z.number().int(),
  expressNo: z.string().min(1).max(64),
})
export type TemuShipExpressNoValidateInput = z.infer<typeof temuShipExpressNoValidateSchema>

/** 每单每 SKU：packageInfos 合计 skuNum 必须等于 deliverSkuNum（create/edit 共用） */
export function refineShipPackageSum(order: {
  deliverOrderDetailInfos: Array<{ productSkuId: number; deliverSkuNum: number }>
  packageInfos: Array<{ packageDetailSaveInfos: Array<{ productSkuId: number; skuNum: number }> }>
}): string | null {
  for (const d of order.deliverOrderDetailInfos) {
    const sum = order.packageInfos.reduce(
      (acc, p) => acc + (p.packageDetailSaveInfos.find((s) => s.productSkuId === d.productSkuId)?.skuNum ?? 0),
      0,
    )
    if (sum !== d.deliverSkuNum) {
      return `SKU ${d.productSkuId} 分箱合计 ${sum} ≠ 发货数 ${d.deliverSkuNum}`
    }
  }
  // 分箱里出现发货明细之外的 SKU 也算不匹配
  const detailIds = new Set(order.deliverOrderDetailInfos.map((d) => d.productSkuId))
  for (const p of order.packageInfos) {
    for (const s of p.packageDetailSaveInfos) {
      if (!detailIds.has(s.productSkuId)) return `分箱包含发货明细之外的 SKU ${s.productSkuId}`
    }
  }
  return null
}

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

/** 图源口径：http(s) URL（>2MB 图选图时浏览器压缩后直传存储 temu/ 前缀，模板只存 URL）。
 *  dataUrl 已停用：会把发品/建模板 server action 载荷顶到 MB 级，被反向代理 413 拒绝。 */
export const IMAGE_SOURCE = z
  .string()
  .max(1000)
  .refine((s) => /^https?:\/\/\S+$/.test(s), {
    message: "图源仅支持 http(s) URL（页面版本过旧时请刷新后重试）",
  })
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
    // 电子说明书（模板只存存储 sourceUrl；发品时服务端取回字节按目标店铺
    // instructions.upload 换 pdfId。base64 为存量模板兼容，列表响应剥离）
    guideFile: z
      .object({
        fileName: z.string().trim().min(1).max(200),
        /** 兼容旧模板（无源时发品用存量 id，跨店可能报错） */
        pdfMaterialId: z.coerce.number().int().positive().optional(),
        languages: z.array(z.string().trim().min(2).max(10)).min(1).max(10).default(["en"]),
        /** PDF 源（选择时已直传存储 temu/ 前缀；不过期长存） */
        sourceUrl: z.string().url().max(1000).optional(),
        /** 存量模板的 PDF 源（base64；物化脚本迁移后不再产生） */
        base64: z.string().min(10).max(20_000_000).optional(),
      })
      .refine((g) => Boolean(g.base64 ?? g.sourceUrl ?? g.pdfMaterialId), {
        message: "缺少 PDF 源（请重新选择 PDF 文件）",
        path: ["sourceUrl"],
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

/** 图片上传（imageUrl 由服务端拉取后传官方图床；dataUrl 入参已停用——
 *  调用方（向导官方校验/尺寸图）先物化为存储 URL 再调用） */
export const temuPublishImageSchema = z.object({
  imageUrl: z.string().url().max(1000),
})

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

/** 电子说明书 PDF 独立上传（sourceUrl → 服务端取回字节 → bg.glo.goods.instructions.upload → pdfId） */
export const temuPublishGuideFileSchema = z.object({
  sourceUrl: z.string().url().max(1000),
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
  /** 缺省=全部店铺（逐店扇出查询合并，行级带 storeId/storeName） */
  store: z.string().uuid().optional(),
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

// ---------- 退货工作台（退供三件套，实时拉取不落库；docs §8.17） ----------

/** 出库时间窗预设（天）。退供接口查询结果超 5 万条报 100000001，
 *  无界查询不可用，强制有界窗口（returnpackage.get 可选窗 / returnpackagelist.get 必填窗）。
 *  returnpackagelist.get（SKU 明细）窗口上限 31 天——2026-10-29 真实店实测
 *  100000004「Participation time exceeds 31 day」，预设独立收窄 */
export const temuReturnWindowSchema = z.enum(["30", "90", "365"])
export const temuReturnSkuWindowSchema = z.enum(["7", "30", "31"])

/** 退供包裹列表（bg.refund.returnpackage.get：supplierId 必填来自本地 ship_order，分页 1~200） */
export const temuReturnListQuerySchema = z.object({
  store: z.string().uuid(),
  /** 1-待提货 2-已出库；缺省=全部 */
  status: z.enum(["1", "2"]).optional(),
  window: temuReturnWindowSchema.default("90"),
  /** 精确筛选（逗号分隔多值 → 官方数组参数），三参数独立映射不做模糊合一 */
  expressDeliverySn: z.string().trim().max(256).optional(),
  purchaseSubOrderSn: z.string().trim().max(256).optional(),
  returnSupplierPackageNo: z.string().trim().max(256).optional(),
  pageNo: z.coerce.number().int().min(1).max(200).default(1),
})

/** 退供包裹详情（bg.refund.returnpackagedetail.get：supplierId + 退供包裹号） */
export const temuReturnDetailQuerySchema = z.object({
  store: z.string().uuid(),
  returnSupplierPackageNo: z.string().trim().min(1).max(64),
})

/** 退供包裹 SKU 明细列表（bg.refund.returnpackagelist.get：出库时间窗必填，≤31 天） */
export const temuReturnSkuQuerySchema = z.object({
  store: z.string().uuid(),
  window: temuReturnSkuWindowSchema.default("30"),
  returnSupplierPackageNo: z.string().trim().max(256).optional(),
  purchaseSubOrderSn: z.string().trim().max(256).optional(),
  pageNo: z.coerce.number().int().min(1).max(200).default(1),
})

