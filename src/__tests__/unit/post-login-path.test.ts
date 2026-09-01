import { describe, it, expect } from "vitest"
import { postLoginPath } from "@/lib/auth/post-login"

/**
 * 登录后落地页单测：超管 → /platform（无企业作用域），普通用户 → /create。
 * 与 login/page.tsx（已登录跳转）、loginAction（登录成功跳转）共用同一函数。
 */
describe("postLoginPath", () => {
  it("超管落地平台管理台", () => {
    expect(postLoginPath(true)).toBe("/platform")
  })

  it("普通用户落地创作页", () => {
    expect(postLoginPath(false)).toBe("/create")
  })
})
