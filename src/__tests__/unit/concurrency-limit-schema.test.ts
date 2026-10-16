import { describe, expect, it } from "vitest"

import {
  chatModelConfigSchema,
  modelConfigSchema,
  permissionGroupSchema,
} from "@/server/schemas/admin"
import {
  createEnterpriseSchema,
  updateEnterpriseConcurrencySchema,
} from "@/server/schemas/platform"

/**
 * 并发上限统一 9999 守卫（2026-10-15 口径调整：超管企业级 / 企业权限组级 /
 * 模型级——企业自建与平台预置共用 modelConfigSchema / chatModelConfigSchema）：
 * 三层「模型 / 权限组 / 企业」取最小的执行逻辑在 task-queue.ts 与
 * llm-slots.ts，本测试只锁校验上限防回归（9999 放行、10000 拒绝）。
 */

const ENT_ID = "22222222-2222-4222-8222-222222222222"

/** 各 schema 的最小合法夹具（并发字段由用例覆写） */
const groupBase = { name: "测试权限组" }
const imageModelBase = {
  name: "test-image-model",
  displayName: "测试生图模型",
  apiEndpoint: "https://api.example.com/v1",
  apiFormat: "openai" as const,
}
const chatModelBase = {
  name: "test-chat-model",
  displayName: "测试对话模型",
  apiEndpoint: "https://api.example.com/v1",
}
const createEnterpriseBase = { name: "测试企业", slug: "test-ent" }

describe("并发上限 9999（权限组 / 模型 / 企业）", () => {
  it.each([
    ["permissionGroupSchema（企业→权限组）", (v: number) =>
      permissionGroupSchema.safeParse({ ...groupBase, maxConcurrent: v })],
    ["modelConfigSchema（生图模型，自建+预置共用）", (v: number) =>
      modelConfigSchema.safeParse({ ...imageModelBase, maxConcurrent: v })],
    ["chatModelConfigSchema（对话模型，自建+预置共用）", (v: number) =>
      chatModelConfigSchema.safeParse({ ...chatModelBase, maxConcurrent: v })],
    ["createEnterpriseSchema.maxConcurrent（超管建企业·生图）", (v: number) =>
      createEnterpriseSchema.safeParse({ ...createEnterpriseBase, maxConcurrent: v })],
    ["createEnterpriseSchema.chatMaxConcurrent（超管建企业·对话）", (v: number) =>
      createEnterpriseSchema.safeParse({ ...createEnterpriseBase, chatMaxConcurrent: v })],
    ["updateEnterpriseConcurrencySchema.maxConcurrent（超管改企业·生图）", (v: number) =>
      updateEnterpriseConcurrencySchema.safeParse({
        enterpriseId: ENT_ID,
        maxConcurrent: v,
        chatMaxConcurrent: 5,
      })],
    ["updateEnterpriseConcurrencySchema.chatMaxConcurrent（超管改企业·对话）", (v: number) =>
      updateEnterpriseConcurrencySchema.safeParse({
        enterpriseId: ENT_ID,
        maxConcurrent: 5,
        chatMaxConcurrent: v,
      })],
  ])("%s：9999 放行", (_label, parse) => {
    expect(parse(9999).success).toBe(true)
  })

  it.each([
    ["permissionGroupSchema", (v: number) =>
      permissionGroupSchema.safeParse({ ...groupBase, maxConcurrent: v })],
    ["modelConfigSchema", (v: number) =>
      modelConfigSchema.safeParse({ ...imageModelBase, maxConcurrent: v })],
    ["chatModelConfigSchema", (v: number) =>
      chatModelConfigSchema.safeParse({ ...chatModelBase, maxConcurrent: v })],
    ["createEnterpriseSchema.maxConcurrent", (v: number) =>
      createEnterpriseSchema.safeParse({ ...createEnterpriseBase, maxConcurrent: v })],
    ["createEnterpriseSchema.chatMaxConcurrent", (v: number) =>
      createEnterpriseSchema.safeParse({ ...createEnterpriseBase, chatMaxConcurrent: v })],
    ["updateEnterpriseConcurrencySchema（生图+对话任一超限即拒）", (v: number) =>
      updateEnterpriseConcurrencySchema.safeParse({
        enterpriseId: ENT_ID,
        maxConcurrent: v,
        chatMaxConcurrent: v,
      })],
  ])("%s：10000 拒绝", (_label, parse) => {
    expect(parse(10000).success).toBe(false)
  })
})
