/* CDP 工具：文档站 SPA 内导航+DOM 检索（找编辑接口文档页 URL）。
 * 运行：cmd //c pnpm tsx scripts/cdp-doc-search.ts */
async function main() {
  const tabs = await (await fetch("http://127.0.0.1:9222/json")).json() as Array<{ type: string; webSocketDebuggerUrl: string }>
  const tab = tabs.find((t) => t.type === "page")
  if (!tab) throw new Error("无可用 tab")
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map<number, (v: unknown) => void>()
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve) => {
      const mid = ++id
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg)
      pending.delete(msg.id)
    }
  }
  await new Promise<void>((r) => { ws.onopen = () => r() })

  const evalJs = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }) as {
      result?: { result?: { value?: unknown }; exceptionDetails?: unknown }
    }
    return r.result?.result?.value
  }

  // 1. 打开文档站 API 文档区
  await send("Page.navigate", { url: "https://agentpartner.temu.com/document" })
  await new Promise((s) => setTimeout(s, 6000))
  const loc1 = await evalJs("location.href")
  console.log("当前 URL:", loc1)

  // 2. 侧栏 DOM 找「编辑」相关节点及链接
  const links = await evalJs(`(() => {
    const out = []
    for (const a of document.querySelectorAll('a')) {
      const t = (a.textContent || '').trim()
      if (/编辑|edit/i.test(t)) out.push(t + ' => ' + a.getAttribute('href'))
    }
    return out.slice(0, 40).join('\\n')
  })()`)
  console.log("编辑相关链接:\n", links)

  // 3. 页面上是否有搜索入口按钮
  const searchHint = await evalJs(`(() => {
    const el = document.querySelector('input[type=text],input[placeholder]')
    return el ? el.getAttribute('placeholder') : '(no input)'
  })()`)
  console.log("搜索框 placeholder:", searchHint)

  ws.close()
  process.exit(0)
}

void main()
