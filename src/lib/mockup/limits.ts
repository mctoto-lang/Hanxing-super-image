/** PSD 模板上传大小上限，对齐 PS-API POST /v1/templates/upload-url 的 sizeBytes 上限 */
export const MAX_PSD_UPLOAD_BYTES = 314572800 // 300MB

/** 字体上传大小上限（.ttf/.otf/.ttc），对齐 PS-API 字体服务校验 */
export const MAX_FONT_UPLOAD_BYTES = 52428800 // 50MB
