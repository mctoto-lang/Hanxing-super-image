/**
 * 登录后落地页（登录页已登录跳转 / loginAction 成功跳转共用）：
 * 超管无企业作用域，进入 /create 等页面会因 getCurrentEnterpriseScope 抛错
 * （proxy.ts 也会把超管从企业页重定向到 /platform），统一落到平台管理台。
 */
export function postLoginPath(isSuperAdmin: boolean): string {
  return isSuperAdmin ? "/platform" : "/create"
}
