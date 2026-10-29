/**
 * 图片上传大小上限（presign 直传与 /api/upload 服务器转存统一）
 *
 * 样机设计稿为印刷分辨率导出图，常超过此前 10MB 的限制；
 * 单张上限 20MB，远低于外部渲染服务的素材上限（150MB），两端均安全。
 */
export const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024
/** 413 响应体 / 前端 toast 使用的可读文案 */
export const MAX_IMAGE_UPLOAD_MESSAGE = "单张图片最大 20MB"

/** 允许的位图 MIME 类型（参考图 / 头像 / 预签名直传统一）。
 *  不含 SVG：位图场景用不到；需要 SVG 的配置图走 /api/upload/config
 *  （sanitizeSvg 清洗后放行）。 */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const

/**
 * TEMU 发品说明书 PDF（上传即落存储 temu/ 前缀，模板只存 sourceUrl，
 * 不再走 base64 进 server action 载荷）。15MB 与既有 base64 换算上限
 * （14.5MB 前端预检）同量级。
 */
export const MAX_PDF_UPLOAD_BYTES = 15 * 1024 * 1024
export const MAX_PDF_UPLOAD_MESSAGE = "说明书 PDF 最大 15MB"
export const ALLOWED_PDF_TYPES = ["application/pdf"] as const

/** 上传目标前缀类别：reference=参考图（ref/，会过期）；temu=发品素材源
 *  （temu/，不过期——压缩衍生图与说明书必须长存，模板会长期引用） */
export const UPLOAD_CATEGORIES = ["reference", "temu"] as const
export type UploadCategory = (typeof UPLOAD_CATEGORIES)[number]
