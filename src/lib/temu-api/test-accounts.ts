/**
 * TEMU 开放平台官方测试账号（文档《基本信息》- 测试账号，2026-09 版）
 *
 * 仅供开发联调：平台级配置 testMode=true 时由 app-config 选用。
 * 沙箱数据与生产可能有差异，字段映射以实测为准（jsonb 兜底列兜住）。
 */

export interface TemuTestAccount {
  /** 账号标识（展示用） */
  label: string
  appKey: string
  appSecret: string
  accessToken: string
  mallId: string
  mallName: string
  /** full=全托 semi=半托 */
  mallType: "full" | "semi"
}

export const TEST_ACCOUNTS = {
  /** 全托管测试账号 1（girl clothes） */
  fullManaged: {
    label: "官方全托测试账号（girl clothes）",
    appKey: "47bb4bb7769e12d9f7aa93cf029fe529",
    appSecret: "ac0a3e952eaaa5b19c0e615c2ef497f50afa6e49",
    accessToken: "fdqozgeoo0e6kd05nr5wnphs3wv6cvkd3hfmljubpegsrruciyuyq9vs",
    mallId: "1052202882",
    mallName: "girl clothes",
    mallType: "full",
  } satisfies TemuTestAccount,
  /** 半托管测试账号 1（girl clothesss） */
  semiManaged: {
    label: "官方半托测试账号（girl clothesss）",
    appKey: "47bb4bb7769e12d9f7aa93cf029fe529",
    appSecret: "ac0a3e952eaaa5b19c0e615c2ef497f50afa6e49",
    accessToken: "ti7xnnaewuvy1u3l8pbzzjheaidux2cpkfvzz5yzo6zf6mmwa3qyrhag",
    mallId: "634418215494106",
    mallName: "girl clothesss",
    mallType: "semi",
  } satisfies TemuTestAccount,
} as const
