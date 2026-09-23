/**
 * 工作台参考图批量上传（历史入口，保持 import 路径稳定）
 *
 * 实现已统一收敛到 src/lib/upload/reference-image.ts：
 * 校验规则（20MB / PNG/JPEG/WEBP/GIF / 8192px）与服务端一致，并行上传。
 */
export {
  uploadReferenceImages,
  type UploadResult,
} from "@/lib/upload/reference-image"
