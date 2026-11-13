/* CDP：读文档中心页面登录态（只读 DOM/URL，不碰密码/不截图）。
 * 运行：cmd //c pnpm tsx scripts/cdp-login-check.ts [urlContains] */
const filter = process.argv[2] ?? "agentpartner.temu.com/document"

async function main() {
  const tabs = await (await fetch("http://127.0.0.1:9222/json")).json() as Array<{
    type: string; url: string; webSocketDebuggerUrl: string
  }>
  // 与 cdp-activate.ts 同口径优先文档中心，避免命中其他 temu.com 页面；文档中心未登录被 302 到登录域名时兜底任一 temu.com 标签
  const pages = tabs.filter((t) => t.type === "page")
  const tab = pages.find((t) => t.url.includes(filter)) ?? pages.find((t) => t.url.includes("temu.com"))
  if (!tab) throw new Error(`未找到含 ${filter}（或 temu.com）的标签页: ` + pages.map(t => t.url).join(", "))
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
      error?: { message?: string }
      result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
    }
    if (r.error) throw new Error(`Runtime.evaluate 失败: ${r.error.message ?? JSON.stringify(r.error)}`)
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails
      throw new Error(`Runtime.evaluate 抛错: ${d.exception?.description ?? d.text ?? JSON.stringify(d)}`)
    }
    return r.result?.result?.value
  }
  const info = await evalJs(`(() => {
    const url = location.href
    const body = document.body ? document.body.innerText.slice(0, 1200) : ''
    const hasLoginBtn = /登录|log ?in/i.test(body) && body.length < 600
    const sideNames = [...document.querySelectorAll('a,li,span,div')].map(e => (e.textContent||'').trim()).filter(t => /API文档|编辑API组|货品API组|帮助中心|公告/.test(t))
    // cookie 名单（只报名，不报值）
    const cookieNames = document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean)
    return JSON.stringify({ url, bodyLen: body.length, hasLoginBtn, sideHits: [...new Set(sideNames)].slice(0, 12), cookieNames: cookieNames.slice(0, 20) })
  })()`)
  console.log(info)
  ws.close()
  process.exit(0)
}

void main()
