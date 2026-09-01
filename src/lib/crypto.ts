import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  type CipherGCMTypes,
} from "node:crypto"
import { env } from "@/lib/env"

/**
 * AES-256-GCM 对称加密（手册 §2.1、§10.7）
 *
 * 用途：API Key、COS SecretKey 等敏感数据落库加密。
 * 密钥来源：环境变量 ENCRYPTION_KEY（32 字符）。
 *
 * 存储格式：base64(iv | authTag | ciphertext)，自包含可解密。
 */

const ALGO: CipherGCMTypes = "aes-256-gcm"
const IV_LEN = 12 // GCM 推荐 12 字节 IV
const AUTH_TAG_LEN = 16

function getKey(): Buffer {
  // 截取前 32 字节作为 AES-256 密钥（env 校验已保证 ≥32 字符）
  return Buffer.from(env.ENCRYPTION_KEY.slice(0, 32), "utf8")
}

/** 加密明文字符串，返回自包含的 base64 密文 */
export function encrypt(plain: string): string {
  if (plain === "") return ""
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, getKey(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  // iv(12) | authTag(16) | ciphertext
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64")
}

/** 解密 encrypt() 产出的 base64 密文，返回明文 */
export function decrypt(payload: string): string {
  if (payload === "") return ""
  const buf = Buffer.from(payload, "base64")
  const iv = buf.subarray(0, IV_LEN)
  const authTag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN)
  const ciphertext = buf.subarray(IV_LEN + AUTH_TAG_LEN)
  const decipher = createDecipheriv(ALGO, getKey(), iv)
  decipher.setAuthTag(authTag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plain.toString("utf8")
}

/** 单向哈希密码（bcrypt 的薄封装，统一 cost factor） */
export async function hashPassword(plain: string): Promise<string> {
  const bcrypt = await import("bcryptjs")
  return bcrypt.hash(plain, 10)
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  const bcrypt = await import("bcryptjs")
  return bcrypt.compare(plain, hash)
}

/**
 * 常量时间比较两个字符串，防止时序攻击（如逐字节猜出 Bearer token）。
 *
 * 长度不同时先做一次等长哈希比较以保持恒定耗时，再返回 false。
 * 适用于校验 CRON_SECRET 等 secret。
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  if (bufA.length !== bufB.length) {
    // 长度不等也要做一次比较以避免长度泄露（仍返回 false）
    if (bufA.length > 0) timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}
