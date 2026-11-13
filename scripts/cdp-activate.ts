/* CDP：激活指定标签页（bringToFront），供用户手动登录文档中心。
 * 运行：cmd //c pnpm tsx scripts/cdp-activate.ts [urlContains] */
const filter = process.argv[2] ?? "agentpartner.temu.com/document"

async function main() {
  const tabs = await (await fetch("http://127.0.0.1:9222/json")).json() as Array<{
    id: string; url: string; title: string; type: string; webSocketDebuggerUrl: string
  }>
  const tab = tabs.find((t) => t.type === "page" && t.url.includes(filter))
  if (!tab) throw new Error(`未找到含 ${filter} 的标签页；现有: ${tabs.filter(t => t.type === 'page').map(t => t.url).join(", ")}`)
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
  const r = await send("Page.bringToFront") as { error?: { message?: string } }
  if (r.error) throw new Error(`Page.bringToFront 失败: ${r.error.message ?? JSON.stringify(r.error)}`)
  console.log(`已激活: ${tab.title} | ${tab.url}`)
  ws.close()
  process.exit(0)
}

void main()
