import { NextResponse } from "next/server"
import { auth } from "@/lib/auth/config"

/**
 * Next.js Proxy（Next.js 16 起 middleware 更名为 proxy）：路由守卫
 * （手册 §5.1、§5.3）
 *
 * 粗粒度守卫（细粒度由 Server Action 内 getCurrentUserContext 完成）：
 *   - 未登录：除白名单（登录页/API auth/health）外，重定向到 /login；
 *   - /platform/*：必须 isSuperAdmin；
 *   - /admin/*：必须 enterpriseRole owner|admin。
 *
 * 注意：模块开关的精确校验（enabledModules ∩ allowedPages）在 Server Action / 页面
 * 通过 getCurrentUserContext 完成（proxy 拿不到企业实时配置，避免每请求查库）。
 */
const PUBLIC_PATHS = [
  "/", // 营销首页：未登录可浏览；已登录由页面按角色重定向进工作台
  "/login",
  "/api/auth", // Auth.js 入口
  "/api/health",
  "/api/cron", // 定时任务端点：机器对机器，由路由内 CRON_SECRET Bearer 鉴权
]

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))
}

export default auth(async (req) => {
  const { pathname } = req.nextUrl
  // auth() 包装器会把 session 注入到 req.auth
  const session = req.auth

  // 静态资源放行：仅限已知静态挂载点。不能用 pathname.includes(".")——
  // 任意深路径带点（如 /platform/foo.js 探测）都会绕过下方角色守卫。
  // public/ 只有根级文件（logo.svg 等），按「单段 + 扩展名」精确放行。
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/uploads") ||
    /^\/[^/]+\.[A-Za-z0-9]+$/.test(pathname)
  ) {
    return NextResponse.next()
  }

  // 公开路径放行
  if (isPublic(pathname)) return NextResponse.next()

  // 未登录 → 登录页
  if (!session?.user) {
    const url = req.nextUrl.clone()
    url.pathname = "/login"
    url.searchParams.set("callbackUrl", pathname)
    return NextResponse.redirect(url)
  }

  const isSuperAdmin = session.user.isSuperAdmin
  const role = session.user.enterpriseRole

  // /platform/* 必须 isSuperAdmin
  if (pathname.startsWith("/platform")) {
    if (!isSuperAdmin) {
      return new NextResponse(null, { status: 403 })
    }
    return NextResponse.next()
  }

  // 超管访问需要企业作用域的业务页时，重定向到 /platform
  // （超管无 enterpriseId，进入 /create 等页面会触发 getCurrentEnterpriseScope 抛错）
  if (isSuperAdmin) {
    const enterpriseScopedPaths = ["/create", "/chat", "/assets", "/workspace", "/product", "/weartry", "/mockup"]
    if (enterpriseScopedPaths.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
      const url = req.nextUrl.clone()
      url.pathname = "/platform"
      return NextResponse.redirect(url)
    }
    return NextResponse.next()
  }

  // /admin/* 必须 owner|admin（企业管理员）
  if (pathname.startsWith("/admin")) {
    if (role !== "owner" && role !== "admin") {
      return new NextResponse(null, { status: 403 })
    }
    return NextResponse.next()
  }

  return NextResponse.next()
})

export const config = {
  // 自托管 Docker 部署（手册 D16）。Next.js 16 起 Proxy 默认运行在 Node.js runtime，
  // 无需显式声明 runtime（crypto/redis 等 Node 模块可直接使用）。
  // 排除静态资源；api/mockup/psd-upload、api/mockup/font-upload 也排除——
  // 大文件上传（PSD ≤300MB / 字体 ≤50MB）经 proxy 层会克隆缓冲请求体
  // （默认上限 10MB，超出截断导致 "Unexpected end of form"），这两个路由
  // 各自 requireEnterpriseContext 鉴权，无需走 proxy 守卫。
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/mockup/psd-upload|api/mockup/font-upload).*)",
  ],
}
