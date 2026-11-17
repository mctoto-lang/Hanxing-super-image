import { describe, it, expect } from "vitest"
import {
  addCardSchema,
  cardPromptTemplateSchema,
  updateCardSchema,
} from "@/server/schemas/workspace"

/**
 * 回归锁：点击「添加卡片」按设计直接落库空白卡（prompt=""），
 * 1d7ff25 补 Zod 边界时 addCardSchema 复用了 min(1) 的 promptSchema
 * 导致必弹「提示词不能为空」——本测试锁定添加卡允许空、其它 prompt
 * 入口（编辑卡片/深化重生成）仍要求非空，防止将来整条放宽。
 */
describe("addCardSchema 允许空白卡片", () => {
  it("空串 / 纯空白串通过（服务端 trim 后落空卡）", () => {
    expect(addCardSchema.safeParse({ prompt: "" }).success).toBe(true)
    expect(addCardSchema.safeParse({ prompt: "   " }).success).toBe(true)
  })

  it("正常提示词通过", () => {
    expect(addCardSchema.safeParse({ prompt: "白色 T 恤正面图" }).success).toBe(true)
  })

  it("超过 4000 字符拒绝", () => {
    const res = addCardSchema.safeParse({ prompt: "x".repeat(4001) })
    expect(res.success).toBe(false)
  })
})

describe("其它 prompt 入口仍要求非空（对照防误放宽）", () => {
  it("updateCardSchema：编辑卡片提示词为空拒绝", () => {
    expect(updateCardSchema.safeParse({ prompt: "" }).success).toBe(false)
  })

  it("cardPromptTemplateSchema：深化/重生成空提示词拒绝", () => {
    const res = cardPromptTemplateSchema.safeParse({
      prompt: "",
      templateId: "tpl-1",
    })
    expect(res.success).toBe(false)
  })
})
