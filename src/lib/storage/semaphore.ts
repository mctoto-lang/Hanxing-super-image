import { env } from "@/lib/env"

/**
 * 简单 FIFO 异步信号量（零依赖）。
 *
 * 用于限制「从 AI 上游回拉图片」的并发下载数（转存下载腿）。生图高并发波次
 * 会同时产生大量转存下载：若无闸门，服务器入方向带宽被均分（500 并发 × 12M
 * 带宽 ≈ 每流 24kbps），2MB 图片要拉十余分钟，全部撞上 30s 下载超时 → 批量
 * 失败 → 触发重试 → 恶性循环。信号量把下载排队化，保证每流带宽足够在超时
 * 内完成；排队等待不计入下载超时（AbortSignal 在获得信号量后才创建）。
 *
 * 上传腿（putObject）不占信号量：开启 COS 内网上传后为内网 Gbps 级，非瓶颈。
 *
 * 进程内全局单例：多 worker 副本各自独立；跨进程总并发由 Redis 企业/模型
 * 槽位约束。上限取 TRANSFER_CONCURRENCY（默认 16，按实测入方向带宽调整，
 * 经验值 ≈ 带宽 Mbps × 2 / 平均图片 MB）。
 */
export class Semaphore {
  private available: number
  private waiters: Array<() => void> = []

  constructor(limit: number) {
    // Math.floor(undefined/NaN) || 1：防御 env 回退路径（未走 zod 默认值）时拿到 undefined
    this.available = Math.max(1, Math.floor(limit) || 1)
  }

  /** 获取一个额度；无可用额度时按 FIFO 排队等待 */
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  /** 释放额度：优先直接移交给队首等待者（available 不变），否则归还池 */
  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.available++
  }
}

/** 转存下载信号量（模块级单例，进程内共享） */
export const transferSemaphore = new Semaphore(env.TRANSFER_CONCURRENCY)
