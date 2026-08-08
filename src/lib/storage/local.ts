import { promises as fs } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { env } from "@/lib/env"

/**
 * 本地文件存储（手册 §3、§10.5）
 *
 * 路径规范：uploads/<enterpriseId>/image/<yyyy>/<mm>/<uuid>.<ext>
 * 缩略图：uploads/<enterpriseId>/thumb/<yyyy>/<mm>/<uuid>.<ext>
 */

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads")

function datePath(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, "0")
  return `${yyyy}/${mm}`
}

function extFromUrl(url: string): string {
  const m = url.match(/\.(jpe?g|png|webp|gif|bmp)(?:\?|#|$)/i)
  return m ? m[1]!.toLowerCase() : "png"
}

export async function saveFromBuffer(
  buffer: Buffer,
  enterpriseId: string,
  ext: string,
  kind: "image" | "thumb" = "image",
): Promise<string> {
  const relDir = `${enterpriseId}/${kind}/${datePath()}`
  const absDir = path.join(UPLOAD_ROOT, relDir)
  await fs.mkdir(absDir, { recursive: true })
  const filename = `${randomUUID()}.${ext}`
  const absPath = path.join(absDir, filename)
  await fs.writeFile(absPath, buffer)
  // 返回可访问的相对 URL（由 /uploads 静态托管或代理）
  const rel = `${relDir}/${filename}`
  return `${env.NEXT_PUBLIC_APP_URL}/uploads/${rel}`
}

export async function saveFromUrl(
  sourceUrl: string,
  enterpriseId: string,
  kind: "image" | "thumb" = "image",
): Promise<string> {
  const ext = extFromUrl(sourceUrl)
  const resp = await fetch(sourceUrl)
  if (!resp.ok) throw new Error(`下载失败: ${resp.status}`)
  const buffer = Buffer.from(await resp.arrayBuffer())
  return await saveFromBuffer(buffer, enterpriseId, ext, kind)
}

export function getLocalPath(relUrl: string): string {
  // 把 /uploads/xxx 映射回绝对路径
  const rel = relUrl.replace(/^.*\/uploads\//, "")
  return path.join(UPLOAD_ROOT, rel)
}

export { UPLOAD_ROOT }
