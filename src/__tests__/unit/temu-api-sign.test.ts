import { describe, expect, it } from "vitest"
import { buildSignSource, signTemuRequest } from "@/lib/temu-api/sign"

/**
 * 官方文档《签名规则》完整样例（已知答案测试）：
 * 排序 → 拼接 → 前后拼 app_secret → MD5 32 位大写 = BA49C39EFE53461582CC779CDA2ADB3E
 */
const DOC_SECRET = "ac0a3e952eaaa5b19c0e615c2ef497f50afa6e49"
const DOC_PARAMS = {
  type: "bg.shiporder.staging.add",
  timestamp: 1739688901,
  app_key: "47bb4bb7769e12d9f7aa93cf029fe529",
  data_type: "JSON",
  access_token:
    "1zz6vlvwq1kulyyyybkdy0bfwnlrgfls8e4ssefhxpanh1mltyodjacc",
  joinInfoList: [
    { deliveryAddressType: 1, subPurchaseOrderSn: "WB2411113267800" },
  ],
}
const DOC_EXPECTED_SIGN = "BA49C39EFE53461582CC779CDA2ADB3E"

describe("signTemuRequest", () => {
  it("通过官方文档样例的已知答案", () => {
    expect(signTemuRequest(DOC_PARAMS, DOC_SECRET)).toBe(DOC_EXPECTED_SIGN)
  })

  it("sign 字段自身不参与签名", () => {
    expect(signTemuRequest({ ...DOC_PARAMS, sign: "x" }, DOC_SECRET)).toBe(
      DOC_EXPECTED_SIGN,
    )
  })

  it("外层 key 按 ASCII 排序、内层对象保持原序（拼接原文快照）", () => {
    expect(buildSignSource(DOC_PARAMS, DOC_SECRET)).toBe(
      DOC_SECRET +
        "access_token1zz6vlvwq1kulyyyybkdy0bfwnlrgfls8e4ssefhxpanh1mltyodjacc" +
        "app_key47bb4bb7769e12d9f7aa93cf029fe529" +
        'data_typeJSONjoinInfoList[{"deliveryAddressType":1,"subPurchaseOrderSn":"WB2411113267800"}]' +
        "timestamp1739688901" +
        "typebg.shiporder.staging.add" +
        DOC_SECRET,
    )
  })

  it("布尔值以 true/false 参与拼接（文档：不可转为 True/False、1/0）", () => {
    const params = { boost: true, a: 1 }
    expect(buildSignSource(params, "s")).toBe("sa1boosttrues")
  })

  it("空数组/空对象以紧凑 JSON 参与拼接", () => {
    expect(buildSignSource({ ids: [], meta: {} }, "s")).toBe(
      'sids[]meta{}s',
    )
  })
})
