import { describe, it, expect } from "vitest"
import { buildNavMain } from "@/components/sidebar/sidebar-data"
import { matchTitle } from "@/components/sidebar/dashboard-header-title"
import type { UserContext } from "@/lib/auth/session"
import { enterprises } from "@/db/schema"
import type { ModuleName } from "@/db/schema"
import {
  NAV_DEFAULT_TITLES,
  resolveNavTitle,
  TEST_NAV_TEMU_TITLE,
} from "@/lib/modules"

/**
 * 导航名称自定义映射（迁移 0100）纯函数回归：
 * - resolveNavTitle 优先级：显式映射 > 测试开关 TEMU 预设 > 默认名；
 * - buildNavMain 对 chat 顶级项 / 店铺管理组（组名+TEMU 子项）/ 库存管理组 /
 *   图片生成子项 / 「TEMU刊登模板」子项的全部覆盖；
 * - 空映射 / 空白值 / 无企业上下文一律回落默认名。
 */

type EnterpriseRow = typeof enterprises.$inferSelect

const mkCtx = (over: {
  modules?: ModuleName[]
  enterprise?: Partial<Pick<EnterpriseRow, "isTest" | "navTitleOverrides">> | null
  role?: "owner" | "admin" | "member"
}): UserContext => {
  const enterprise =
    over.enterprise === null
      ? null
      : ({
          isTest: false,
          navTitleOverrides: {},
          ...over.enterprise,
        } as unknown as EnterpriseRow)
  const accessibleModules = over.modules ?? ["chat", "temu", "inventory", "create", "workspace"]
  return {
    user: {
      id: "u1",
      username: "u",
      name: "u",
      email: null,
      image: null,
      isSuperAdmin: false,
      enterpriseId: "e1",
      enterpriseRole: over.role ?? "member",
      groupId: null,
      creditsBalance: 0,
    },
    enterprise,
    group: null,
    accessibleModules,
    canAccess: (m) => accessibleModules.includes(m),
  }
}

const titlesOf = (ctx: UserContext) => {
  const groups = buildNavMain(ctx)
  const all: { title: string; url: string }[] = []
  for (const g of groups) {
    all.push({ title: g.title, url: g.url })
    for (const item of g.items ?? []) all.push({ title: item.title, url: item.url })
  }
  return all
}

describe("resolveNavTitle 优先级", () => {
  it("默认名（无映射无开关）", () => {
    expect(resolveNavTitle({}, false, "temu")).toBe("TEMU")
    expect(resolveNavTitle(undefined, false, "storeGroup")).toBe("店铺管理")
  })

  it("测试开关只作用于 temu：预设「数据中心」", () => {
    expect(resolveNavTitle({}, true, "temu")).toBe(TEST_NAV_TEMU_TITLE)
    expect(resolveNavTitle({}, true, "chat")).toBe("AI 对话")
    expect(resolveNavTitle({}, true, "storeGroup")).toBe("店铺管理")
  })

  it("显式映射优先于测试开关预设；空白值视为未设置", () => {
    expect(resolveNavTitle({ temu: "数据港" }, true, "temu")).toBe("数据港")
    expect(resolveNavTitle({ temu: "   " }, true, "temu")).toBe(TEST_NAV_TEMU_TITLE)
    expect(resolveNavTitle({ temu: " " }, false, "temu")).toBe("TEMU")
  })
})

describe("buildNavMain 应用映射", () => {
  it("默认（无企业上下文=超管视角之外的直连渲染）：TEMU/刊登模板为默认名", () => {
    const titles = titlesOf(mkCtx({ enterprise: null })).map((t) => t.title)
    expect(titles).toContain("店铺管理")
    expect(titles).toContain("TEMU")
    expect(titles).toContain("TEMU刊登模板")
  })

  it("测试企业开关：TEMU → 数据中心，刊登模板 → 数据中心刊登模板，其余不变", () => {
    const titles = titlesOf(mkCtx({ enterprise: { isTest: true } })).map((t) => t.title)
    expect(titles).toContain("数据中心")
    expect(titles).not.toContain("TEMU")
    expect(titles).toContain("数据中心刊登模板")
    expect(titles).not.toContain("TEMU刊登模板")
    expect(titles).toContain("店铺管理")
    expect(titles).toContain("AI 对话")
  })

  it("显式映射覆盖各入口：组名/TEMU/chat/库存/图片生成子项/刊登模板前缀", () => {
    const titles = titlesOf(
      mkCtx({
        enterprise: {
          isTest: true,
          navTitleOverrides: {
            storeGroup: "门店中心",
            temu: "数据港",
            chat: "AI 助手",
            inventory: "仓储中心",
            create: "灵感创作",
          },
        },
      }),
    ).map((t) => t.title)
    // 显式 temu 覆盖测试开关预设
    expect(titles).toContain("门店中心")
    expect(titles).toContain("数据港")
    expect(titles).not.toContain("TEMU")
    expect(titles).not.toContain("数据中心")
    expect(titles).toContain("数据港刊登模板")
    expect(titles).toContain("AI 助手")
    expect(titles).toContain("仓储中心")
    expect(titles).toContain("灵感创作")
  })

  it("NAV_DEFAULT_TITLES 与 buildNavMain 默认输出一致（单一来源不漂移）", () => {
    const titles = titlesOf(
      mkCtx({
        enterprise: null,
        modules: ["chat", "temu", "inventory", "create", "workspace", "video", "selection"],
      }),
    ).map((t) => t.title)
    expect(titles).toContain(NAV_DEFAULT_TITLES.temu)
    expect(titles).toContain(NAV_DEFAULT_TITLES.chat)
    expect(titles).toContain(NAV_DEFAULT_TITLES.inventory)
    expect(titles).toContain(NAV_DEFAULT_TITLES.create)
    expect(titles).toContain(NAV_DEFAULT_TITLES.video)
    expect(titles).toContain(NAV_DEFAULT_TITLES.selection)
  })
})

describe("页头 HeaderTitle TEMU 域跟随企业导航名（matchTitle）", () => {
  it("/temu 与 /templates/temu 使用传入的自定义导航名（与侧边栏同口径）", () => {
    expect(matchTitle("/temu", "数据中心")).toBe("数据中心")
    expect(matchTitle("/temu?tab=overview".split("?")[0]!, "数据中心")).toBe(
      "数据中心",
    )
    expect(matchTitle("/templates/temu", "数据中心")).toBe("数据中心刊登模板")
    expect(matchTitle("/templates/temu/1", "数据港")).toBe("数据港刊登模板")
  })

  it("缺省回落默认名；非 TEMU 域路由不受影响", () => {
    expect(matchTitle("/temu", NAV_DEFAULT_TITLES.temu)).toBe("TEMU")
    expect(matchTitle("/templates/temu", NAV_DEFAULT_TITLES.temu)).toBe(
      "TEMU刊登模板",
    )
    expect(matchTitle("/create", "数据中心")).toBe("自由创作")
    expect(matchTitle("/admin/groups", "数据中心")).toBe("权限组")
    expect(matchTitle("/chat", "数据中心")).toBe("AI 对话")
  })
})

describe("video/selection 占位导航", () => {
  it("默认输出两组及全部子项，位于图片生成之后", () => {
    const groups = buildNavMain(
      mkCtx({ modules: ["chat", "create", "video", "selection"] }),
    )
    expect(groups.map((g) => g.title)).toEqual([
      "AI 对话",
      "图片生成",
      "视频生成",
      "选品工具",
    ])
    const video = groups.find((g) => g.title === "视频生成")
    expect(video?.items?.map((i) => i.title)).toEqual([
      "视频创作",
      "视频复刻",
      "带货视频",
      "批量生成",
      "我的作品",
    ])
    const selection = groups.find((g) => g.title === "选品工具")
    expect(selection?.items?.map((i) => i.title)).toEqual([
      "选品发现",
      "市场分析",
      "竞品监控",
      "评论洞察",
      "数据任务",
      "我的选品",
    ])
  })

  it("未开通不渲染；自定义组名覆盖生效", () => {
    const titles = titlesOf(mkCtx({ modules: ["chat", "video"] })).map(
      (t) => t.title,
    )
    expect(titles).toContain("视频生成")
    expect(titles).not.toContain("选品工具")

    const custom = titlesOf(
      mkCtx({
        modules: ["video"],
        enterprise: { navTitleOverrides: { video: "视频工作台" } },
      }),
    ).map((t) => t.title)
    expect(custom).toContain("视频工作台")
    expect(custom).not.toContain("视频生成")
  })
})
