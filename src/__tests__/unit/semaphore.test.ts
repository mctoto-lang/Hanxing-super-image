import { describe, it, expect } from "vitest"
import { Semaphore } from "@/lib/storage/semaphore"

/**
 * 转存下载信号量单测：并发上限、FIFO 排队、额度归还、非法上限防御。
 * （saveFromUrl 的下载腿包裹行为由 cos/local 适配器共用，这里只验证信号量语义）
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("Semaphore 转存信号量", () => {
  it("并发不超过上限：6 个任务争抢 2 个额度，峰值恰好为 2 且全部完成", async () => {
    const sem = new Semaphore(2)
    let concurrent = 0
    let peak = 0
    const done: number[] = []

    await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        await sem.acquire()
        concurrent++
        peak = Math.max(peak, concurrent)
        try {
          await sleep(20)
          done.push(i)
        } finally {
          concurrent--
          sem.release()
        }
      }),
    )

    expect(peak).toBe(2)
    expect(done).toHaveLength(6)
  })

  it("FIFO 排队：额度满时等待者按申请顺序依次获得", async () => {
    const sem = new Semaphore(1)
    await sem.acquire() // 占满唯一额度

    const order: number[] = []
    const waiters = [1, 2, 3].map(async (i) => {
      await sem.acquire()
      order.push(i)
      sem.release()
    })

    await sleep(30) // 确保三个等待者都已入队
    sem.release()
    await Promise.all(waiters)

    expect(order).toEqual([1, 2, 3])
  })

  it("无等待者时 release 归还额度，下一次 acquire 立即成功", async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    sem.release()

    let acquired = false
    await Promise.race([
      sem.acquire().then(() => {
        acquired = true
      }),
      sleep(50),
    ])
    expect(acquired).toBe(true)
  })

  it("非法上限（NaN/0/负数）回退为 1，不产生 NaN 额度", async () => {
    for (const bad of [Number.NaN, 0, -5]) {
      const sem = new Semaphore(bad)
      await sem.acquire() // 必须立即成功（额度 1）
      let secondAcquired = false
      await Promise.race([
        sem.acquire().then(() => {
          secondAcquired = true
        }),
        sleep(30),
      ])
      expect(secondAcquired).toBe(false) // 额度为 1，第二个必须排队
      sem.release()
      sem.release()
    }
  })
})
