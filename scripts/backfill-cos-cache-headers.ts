/**
 * 存量 COS 对象回填 Cache-Control 头。
 *
 * 背景：saveFromBuffer / presignPut 现已为新上传对象声明
 * `public, max-age=31536000, immutable`（UUID 键不可变，浏览器可长缓存，
 * 重复访问不再回源）。本脚本为修复上线前的存量对象补上同样的头：
 * headObject 检查现有元数据 → 缺失者 putObjectCopy 自拷贝
 * （MetadataDirective=Replaced，保留 ContentType/ContentDisposition 与
 * 源对象 ACL（x-cos-acl 透传，防对象级 public-read 策略被重置），追加
 * CacheControl）。
 *
 * 用法：
 *   npx tsx scripts/backfill-cos-cache-headers.ts            # dry-run：只统计
 *   npx tsx scripts/backfill-cos-cache-headers.ts --apply    # 实际写入
 *   npx tsx scripts/backfill-cos-cache-headers.ts --apply --prefix=gen/
 *
 * 幂等可重复执行（已有 immutable 头的对象自动跳过）。
 */

// 先加载本地 .env（开发），生产靠容器注入 env；必须在动态 import 之前执行
try {
  process.loadEnvFile()
} catch {}

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
/** 并发自拷贝数：COS 侧限速友好，避免打满配额 */
const CONCURRENCY = 4

async function main() {
  const apply = process.argv.includes("--apply")
  const prefixArg = process.argv.find((a) => a.startsWith("--prefix="))
  const onlyPrefix = prefixArg ? prefixArg.slice("--prefix=".length) : null

  const { loadStorageConfig } = await import("@/lib/storage/config")
  const COS = (await import("cos-nodejs-sdk-v5")).default

  const cfg = await loadStorageConfig()
  if (cfg.provider !== "cos" || !cfg.cosBucket || !cfg.cosRegion) {
    console.error("当前存储配置不是 COS 模式（或桶/地域缺失），无需回填")
    process.exit(1)
  }

  const cos = new COS({ SecretId: cfg.cosSecretId, SecretKey: cfg.cosSecretKey })
  const prefixes = Array.from(
    new Set([cfg.refPrefix, cfg.configPrefix, cfg.generatePrefix].filter(Boolean)),
  )
  const targets = onlyPrefix
    ? prefixes.filter((p) => p === onlyPrefix || p.startsWith(onlyPrefix))
    : prefixes
  if (targets.length === 0) {
    console.error(`--prefix=${onlyPrefix} 与配置前缀（${prefixes.join(", ")}）均不匹配`)
    process.exit(1)
  }
  console.log(
    `${apply ? "【APPLY】" : "【DRY-RUN】"}桶 ${cfg.cosBucket}，前缀：${targets.join(", ")}`,
  )

  // 1. 列出全部对象（Marker 分页）
  const keys: string[] = []
  for (const prefix of targets) {
    let marker: string | undefined
    for (;;) {
      const listed: string[] = await new Promise((resolve, reject) => {
        cos.getBucket(
          {
            Bucket: cfg.cosBucket,
            Region: cfg.cosRegion,
            Prefix: prefix,
            Marker: marker,
            MaxKeys: 1000,
          },
          (err: Error | null, data: { Contents?: Array<{ Key?: string }> }) => {
            if (err) reject(err)
            else resolve((data.Contents ?? []).map((o) => o.Key ?? "").filter(Boolean))
          },
        )
      })
      keys.push(...listed)
      if (listed.length < 1000) break
      marker = listed[listed.length - 1]
    }
  }
  console.log(`共 ${keys.length} 个对象待检查`)

  // 2. headObject 检查元数据，缺失者（--apply 时）自拷贝补头。
  //    ACL 防御性透传：COS PutObjectCopy 的 x-cos-acl 默认 private，若某桶
  //    依赖「对象级 public-read」（桶私有）模式，自拷贝会把对象重置为
  //    private 导致直链失效——head 读到源对象 ACL 则原样传回。本项目桶为
  //    公有读私有写（桶级策略放行读取），对象 ACL 重置无实际影响，透传
  //    仅为兼容其他桶策略兜底。
  let alreadyOk = 0
  let updated = 0
  let failed = 0
  let processed = 0

  const headObject = (key: string) =>
    new Promise<{
      cacheControl?: string
      contentType?: string
      disposition?: string
      acl?: string
    }>((resolve, reject) => {
        cos.headObject(
          { Bucket: cfg.cosBucket, Region: cfg.cosRegion, Key: key },
          (
            err: Error | null,
            data: { headers?: Record<string, string | undefined> },
          ) => {
            if (err) reject(err)
            else
              resolve({
                cacheControl: data.headers?.["cache-control"],
                contentType: data.headers?.["content-type"],
                disposition: data.headers?.["content-disposition"],
                acl: data.headers?.["x-cos-acl"] ?? undefined,
              })
          },
        )
      })

  const copyWithCacheControl = (key: string, meta: {
    contentType?: string
    disposition?: string
    acl?: string
  }) =>
    new Promise<void>((resolve, reject) => {
      cos.putObjectCopy(
        {
          Bucket: cfg.cosBucket,
          Region: cfg.cosRegion,
          Key: key,
          CopySource: `${cfg.cosBucket}/${key}`,
          MetadataDirective: "Replaced",
          ...(meta.contentType ? { ContentType: meta.contentType } : {}),
          ...(meta.disposition ? { ContentDisposition: meta.disposition } : {}),
          ...(meta.acl ? { ACL: meta.acl } : {}),
          CacheControl: IMMUTABLE_CACHE_CONTROL,
        },
        (err: Error | null) => (err ? reject(err) : resolve()),
      )
    })

  const worker = async (queue: string[], workerId: number) => {
    for (;;) {
      const idx = processed
      if (idx >= queue.length) return
      processed++
      const key = queue[idx]!
      try {
        const meta = await headObject(key)
        if (meta.cacheControl?.includes("immutable")) {
          alreadyOk++
          continue
        }
        if (apply) {
          await copyWithCacheControl(key, meta)
          updated++
        } else {
          updated++ // dry-run 计「需要处理」的数量
        }
        if (updated % 100 === 0) {
          console.log(`  进度：已处理 ${updated} 个需回填对象（worker ${workerId}）`)
        }
      } catch (err) {
        failed++
        console.error(`  失败 ${key}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(keys, i)))

  console.log(
    `完成：${alreadyOk} 个已有缓存头跳过，${updated} 个${apply ? "已回填" : "待回填（dry-run，加 --apply 执行）"}，${failed} 个失败`,
  )
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error("回填失败：", err)
  process.exit(1)
})
