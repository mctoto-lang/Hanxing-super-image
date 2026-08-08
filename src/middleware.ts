import { NextResponse, type NextRequest } from "next/server"
import { auth } from "@/lib/auth/config"

/**
 * Next.js 中间件：路由守卫（手册 §5.1、§5.3）
 *
 * 粗粒度守卫（细粒度由 Server Action 内 getCurrentUserContext 完成）：
 *   - 未登录：除白名单（登录页/API auth/health）外，重定向到 /login；
 *   - /platform/*：必须 isSuperAdmin；
 *   - /admin/*：必须 enterpriseRole owner|admin。
 *
 * 注意：模块开关的精确校验（enabledModules ∩ allowedPages）在 Server Action / 页面
 * 通过 getCurrentUserContext 完成（middleware 拿不到企业实时配置，避免每请求查库）。
 */
const PUBLIC_PATHS = [
  "/login",
  "/api/auth", // Auth.js 入口
  "/api/health",
]

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))
}

export default auth(async (req) => {
  const { pathname } = req.nextUrl
  // auth() 包装器会把 session 注入到 req.auth
  const session = req.auth

  // 静态资源放行
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
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

  // 超管访问业务页时也放行（管理视角）
  if (isSuperAdmin) return NextResponse.next()

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
  // 自托管 Docker 部署（手册 D16），用 Node.js runtime 避免对 Edge 的限制
  // （crypto/redis 等 Node 模块在 middleware 链路中被引用）
  runtime: "nodejs",
  // 排除静态资源
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
