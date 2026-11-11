/* CDP 工具：在登录态浏览器页面上下文里发 XHR（绕过游客限制拿文档站全树）。
 * 运行：cmd //c "pnpm tsx scripts/cdp-fetch.ts <url> <json-body>" */
const [targetUrl, bodyJson] = process.argv.slice(2)

async function main() {
  const tabs = await (await fetch("http://127.0.0.1:9222/json")).json() as Array<{ url: string; webSocketDebuggerUrl: string; type: string }>
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

  await send("Page.navigate", { url: "https://agentpartner.temu.com/document" })
  await new Promise((s) => setTimeout(s, 4000))

  const expr = `fetch(${JSON.stringify(targetUrl)}, {method:'POST', headers:{'content-type':'application/json'}, body:${JSON.stringify(bodyJson ?? "{}")}}).then(r=>r.text())`
  const result = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }) as {
    result?: { result?: { value?: string } }
  }
  console.log(result.result?.result?.value ?? "(empty)")
  ws.close()
  process.exit(0)
}

void main()
