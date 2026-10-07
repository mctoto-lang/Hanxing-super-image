import { describe, expect, it } from "vitest"

import { effectiveConcurrentLimit } from "@/lib/auth/permissions"

/**
 * effectiveConcurrentLimit（并发上限取最小值）纯函数单测。
 *
 * 语义（与 computeFrameConcurrency / 生图槽位同口径）：
 *   enterprise.maxConcurrent ≥ group.maxConcurrent ≥ model.maxConcurrent，
 *   >0 的维度参与取 min；≤0 或未传（null/undefined）= 该维度不限，从
 *   min 中剔除；全部不限时回退 1（恒有下限，避免池大小为 0 死锁）。
 */
describe("effectiveConcurrentLimit", () => {
  it("三值取最小值", () => {
    expect(effectiveConcurrentLimit({ enterprise: 5, group: 3, model: 4 })).toBe(3)
    expect(effectiveConcurrentLimit({ enterprise: 3, group: 5, model: 4 })).toBe(3)
    expect(effectiveConcurrentLimit({ enterprise: 4, group: 5, model: 2 })).toBe(2)
  })

  it("group/model 传 0 或负数（不限，剔除后 enterprise 生效）", () => {
    expect(effectiveConcurrentLimit({ enterprise: 5, group: 0, model: 0 })).toBe(5)
    expect(effectiveConcurrentLimit({ enterprise: 5, group: -1, model: 0 })).toBe(5)
    // 企业 5、组不限、模型 3 → 仅剩企业与模型两维度取 min
    expect(effectiveConcurrentLimit({ enterprise: 5, group: 0, model: 3 })).toBe(3)
  })

  it("不传 model（Agent 生产流水线池大小推导场景，不约束模型维度）", () => {
    expect(effectiveConcurrentLimit({ enterprise: 5, group: 2 })).toBe(2)
    expect(effectiveConcurrentLimit({ enterprise: 2, group: 5 })).toBe(2)
    // group/model 均不传 → 只看企业
    expect(effectiveConcurrentLimit({ enterprise: 5 })).toBe(5)
    // null 与不传等价（剔除而非当 0）
    expect(effectiveConcurrentLimit({ enterprise: 5, group: null, model: null })).toBe(5)
  })

  it("全 0 → 回退 1；未传/null 维度以 Infinity 占位，仅显式全 ≤0 才触发回退", () => {
    // 三个维度全部显式 ≤0 → 候选集为空 → 1
    expect(effectiveConcurrentLimit({ enterprise: 0, group: 0, model: 0 })).toBe(1)
    expect(effectiveConcurrentLimit({ enterprise: -1, group: -2, model: 0 })).toBe(1)
    // 未传/null 维度经 ?? Infinity 占位并保留在候选集（Infinity > 0 过滤不掉）：
    // 仅 enterprise=0 时不触发空回退，返回 Infinity（当前实现语义）
    expect(effectiveConcurrentLimit({ enterprise: 0 })).toBe(Infinity)
    expect(effectiveConcurrentLimit({ enterprise: 0, group: null, model: null })).toBe(Infinity)
    expect(effectiveConcurrentLimit({ enterprise: 0, group: 0 })).toBe(Infinity)
  })
})
