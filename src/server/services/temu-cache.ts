/**
 * Temu 面板读缓存（进程内短 TTL + 写路径显式失效）
 *
 * 面板的聚合查询（趋势/类目占比/TOP 榜/广告效果/漏斗/流量明细）每次刷新
 * 全量重算，快照表随插件采集持续增长会越来越慢。这里加 30s TTL 进程内
 * 缓存：写路径（插件 ingest 上报 / 店铺管理变更）显式失效，其余场景最多
 * 30s 陈旧——采集数据本身非实时强一致，可接受。
 *
 * 进程内缓存：多副本部署时失效只影响本进程，其余副本最多 30s 陈旧
 * （与 mockup-template-cache / presence 缓存同策略）。
 */

const TEMU_CACHE_TTL_MS = 30_000
const MAX_ENTRIES = 500

interface CacheEntry {
  expiresAt: number
  value: unknown
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<unknown>>()

function prune(): void {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key)
  }
  while (cache.size > MAX_ENTRIES) {
    const first = cache.keys().next().value
    if (first == null) break
    cache.delete(first)
  }
}

/** 读穿缓存：命中直接返回；未命中加载一次（并发去重，失败不缓存）。
 *  opts.ttlMs 覆盖默认 30s（如广告分批加载要 40-60s 的读用 5 分钟），失效仍走写路径显式失效 */
export async function temuCached<T>(
  key: string,
  load: () => Promise<T>,
  opts?: { ttlMs?: number },
): Promise<T> {
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value as T
  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending
  const p = (async () => {
    try {
      const value = await load()
      cache.set(key, { expiresAt: Date.now() + (opts?.ttlMs ?? TEMU_CACHE_TTL_MS), value })
      if (cache.size > MAX_ENTRIES) prune()
      return value
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

/** 失效企业全部 Temu 面板缓存（ingest 写入 / 店铺管理变更后调用）。
 *  storeId 提供时收敛为只失效该店键（键约定 {enterpriseId}:{scope}:{storeId}[:后缀]，
 *  第 2 段精确匹配）：单店写操作（如广告）全企业失效会连带其他店的 5 分钟缓存，
 *  写后全店视图逐店重拉 detail.query 可达分钟级 */
export function invalidateTemuCache(enterpriseId: string, storeId?: string): void {
  const prefix = `${enterpriseId}:`
  for (const key of [...cache.keys()]) {
    if (!key.startsWith(prefix)) continue
    if (storeId != null && key.slice(prefix.length).split(":")[1] !== storeId) continue
    cache.delete(key)
  }
}
