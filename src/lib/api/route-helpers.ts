import { NextResponse } from "next/server"

/**
 * API 路由处理器统一助手
 *
 * 统一前的问题：各 route.ts 手写错误响应，且处理器内异常（存储故障 /
 * DB 不可用 / formData 解析失败）直接冒泡为无信息量的裸 500。
 *
 * 错误体统一为纯文本——前端 upload-image.ts 读取失败响应的明文原因
 * 用于 toast 提示，不要改成 JSON。
 */

/** 纯文本错误响应（状态码 + 消息） */
export function apiError(message: string, status: number): NextResponse {
  return new NextResponse(message, { status })
}

/**
 * 包装路由处理器：把未捕获异常兜底为带原因的 500。
 * 存储故障等意外异常不再以空体 500 返回（浏览器只显示「当前无法
 * 处理此请求」，无法定位问题），同时服务端保留完整错误日志。
 */
export function withRouteHandler(
  handler: (request: Request) => Promise<NextResponse>,
): (request: Request) => Promise<NextResponse> {
  return async (request) => {
    try {
      return await handler(request)
    } catch (err) {
      console.error("[api-route] unhandled error:", err)
      const msg = err instanceof Error ? err.message : String(err)
      return apiError(`internal error: ${msg.slice(0, 200)}`, 500)
    }
  }
}
