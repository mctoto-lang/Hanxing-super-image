/**
 * SSE 流解析器（四种对话格式共用）
 *
 * 按 RFC：事件块以空行分隔，块内 `event:` 行指定类型、`data:` 行承载数据
 * （多行 data 以 \n 拼接）。openai 仅用 data 行 + `[DONE]` 哨兵；
 * claude / gemini 用 event + data 组合。
 */

export interface SseEvent {
  event?: string
  data: string
}

/** 解析单个事件块（不含分隔空行） */
function parseSseBlock(block: string): SseEvent | null {
  let event: string | undefined
  const dataLines: string[] = []
  for (const rawLine of block.split(/\r?\n/)) {
    // 注释行（":" 开头）与无关字段（id:/retry:）跳过
    if (rawLine.startsWith(":")) continue
    const colonIdx = rawLine.indexOf(":")
    if (colonIdx === -1) continue
    const field = rawLine.slice(0, colonIdx).trim()
    let value = rawLine.slice(colonIdx + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") dataLines.push(value)
  }
  if (event === undefined && dataLines.length === 0) return null
  return { event, data: dataLines.join("\n") }
}

/**
 * 逐事件读取 SSE 响应体。
 * 上游异常断流由调用方捕获（reader.read 会 reject）。
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 事件块以空行（\n\n 或 \r\n\r\n）分隔
      for (;;) {
        const match = buffer.match(/\r?\n\r?\n/)
        if (!match || match.index === undefined) break
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const parsed = parseSseBlock(block)
        if (parsed) yield parsed
      }
    }
    // 尾块（上游未以空行结束的残留数据）
    if (buffer.trim()) {
      const parsed = parseSseBlock(buffer)
      if (parsed) yield parsed
    }
  } finally {
    reader.releaseLock()
  }
}
