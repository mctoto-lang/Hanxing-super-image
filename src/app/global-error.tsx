"use client"

/**
 * 根级错误兜底（root layout 自身渲染失败时触发，必须自带 html/body）。
 * 业务页面错误由各路由组 error.tsx 捕获，不会走到这里。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="zh-CN" className="dark">
      <body
        style={{
          margin: 0,
          minHeight: "100svh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#0a0a0a",
          color: "#fafafa",
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
            应用出现异常
          </h1>
          <p style={{ color: "#a1a1aa", fontSize: "0.875rem" }}>
            {error.message || "发生未知错误"}
            {error.digest ? `（${error.digest}）` : ""}
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "1px solid #3f3f46",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            重试
          </button>
        </div>
      </body>
    </html>
  )
}
