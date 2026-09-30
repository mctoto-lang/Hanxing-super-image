/**
 * 服务端回源响应体的受限读取：超过 maxBytes 立即中止并取消下载，
 * 防止超大/慢响应把内存打爆（OOM 面）。
 */
export async function readBodyBounded(resp: Response, maxBytes: number): Promise<Buffer> {
  if (!resp.body) {
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.byteLength > maxBytes) throw new Error(`响应超过大小上限（${maxBytes} 字节）`)
    return buf
  }
  const reader = resp.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`响应超过大小上限（${maxBytes} 字节）`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}
