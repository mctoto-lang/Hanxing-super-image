/**
 * 图片上传大小上限（presign 直传与 /api/upload 服务器转存统一）
 *
 * 样机设计稿为印刷分辨率导出图，常超过此前 10MB 的限制；
 * 单张上限 20MB，远低于外部渲染服务的素材上限（150MB），两端均安全。
 */
export const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024
/** 413 响应体 / 前端 toast 使用的可读文案 */
export const MAX_IMAGE_UPLOAD_MESSAGE = "单张图片最大 20MB"
