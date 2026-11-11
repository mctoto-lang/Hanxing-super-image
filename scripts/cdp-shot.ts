/* CDP 工具：截图 + 页面文本摘要。运行：cmd //c pnpm tsx scripts/cdp-shot.ts [url] [waitMs] [outPng] */
const [url, waitMsArg, outPng] = process.argv.slice(2)

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
      result?: { result?: { value?: unknown } }
    }
    return r.result?.result?.value
  }

  if (url) {
    await send("Page.navigate", { url })
    await new Promise((s) => setTimeout(s, Number(waitMsArg) || 6000))
  }
  console.log("URL:", await evalJs("location.href"))
  console.log("title:", await evalJs("document.title"))
  const text = await evalJs("document.body.innerText.slice(0, 800)")
  console.log("---- body 文本 ----\n", text)

  const shot = await send("Page.captureScreenshot", { format: "png" }) as { result?: { data?: string } }
  if (shot.result?.data) {
    const { writeFileSync } = await import("node:fs")
    writeFileSync(outPng || ".zcode/probe-doc.png", Buffer.from(shot.result.data, "base64"))
    console.log("\n截图已存:", outPng || ".zcode/probe-doc.png")
  }
  ws.close()
  process.exit(0)
}

void main()
