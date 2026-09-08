/**
 * 上传本地图片到 COS config/ 前缀（不过期的静态资源：登录页视觉图等）。
 *
 * 用法：pnpm tsx scripts/upload-config-asset.ts <本地图片路径>
 *
 * enterpriseId 固定 "_platform"（与 /api/upload/config 超管无企业时的约定一致）。
 * 要求平台存储配置 provider=cos 且凭证齐全——不降级 local：/uploads 已收紧为
 * 登录态访问，未登录页面（如登录页）引用本地 URL 会 401。
 *
 * 注意：loadEnvFile 必须早于任何会触发 env.ts 校验的 import，故依赖一律用动态 import
 * （与 scripts/create-test-data.ts、scripts/worker.ts 一致）。
 */
try {
  process.loadEnvFile()
} catch {
  // ignore
}

void (async () => {
  const { readFile } = await import("node:fs/promises")
  const { loadStorageConfig } = await import("@/lib/storage/config")
  const { createCosAdapter } = await import("@/lib/storage/cos")

  const filePath = process.argv[2]
  if (!filePath) {
    console.error("用法: pnpm tsx scripts/upload-config-asset.ts <本地图片路径>")
    process.exit(1)
  }

  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  if (!["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
    console.error(`不支持的扩展名: .${ext}（仅 png/jpg/jpeg/webp/gif）`)
    process.exit(1)
  }

  const cfg = await loadStorageConfig()
  if (cfg.provider !== "cos" || !cfg.cosSecretId || !cfg.cosSecretKey || !cfg.cosRegion || !cfg.cosBucket) {
    console.error(
      "存储配置未就绪：需要 provider=cos 且 SecretId/SecretKey/Region/Bucket 齐全（超管后台 /platform/system 配置）",
    )
    process.exit(1)
  }

  const buffer = await readFile(filePath)
  console.log(`读取文件: ${filePath}（${(buffer.length / 1024).toFixed(0)} KB）`)

  const adapter = createCosAdapter(cfg)
  const url = await adapter.saveFromBuffer(buffer, "_platform", ext, "config")
  console.log(`✓ 上传成功: ${url}`)
  process.exit(0)
})().catch((err) => {
  console.error("上传失败:", err instanceof Error ? err.message : err)
  process.exit(1)
})
