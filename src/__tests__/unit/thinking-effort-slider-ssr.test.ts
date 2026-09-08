import { describe, it, expect } from "vitest"
import * as React from "react"
import { renderToString } from "react-dom/server"
import { ThinkingEffortSlider } from "@/components/chat/thinking-effort-slider"

/**
 * 思考强度滑杆 SSR 安全（回归测试）
 *
 * client 组件在 Next.js 中仍会被服务端渲染：web component 的类声明
 * `extends HTMLElement` 在 Node 模块求值时即会抛 "HTMLElement is not
 * defined"。此测试在无 DOM 全局的 node 环境复现该求值路径，防止回归。
 */
describe("ThinkingEffortSlider SSR 安全", () => {
  it("node 环境模块求值不抛 HTMLElement 未定义", () => {
    // 前置：确认本测试环境确实无 DOM 全局（等价于 SSR 求值环境）
    expect(typeof HTMLElement).toBe("undefined")
    expect(typeof customElements).toBe("undefined")
  })

  it("renderToString 输出包含自定义元素标签与 value 属性", () => {
    const html = renderToString(
      React.createElement(ThinkingEffortSlider, {
        value: "medium",
        onChange: () => {},
      }),
    )
    expect(html).toContain("<thinking-effort-slider")
    expect(html).toContain('value="2"')
  })

  it("off 状态 SSR 输出最左档 value=0", () => {
    const html = renderToString(
      React.createElement(ThinkingEffortSlider, {
        value: "off",
        onChange: () => {},
      }),
    )
    expect(html).toContain("<thinking-effort-slider")
    expect(html).toContain('value="0"')
  })
})
