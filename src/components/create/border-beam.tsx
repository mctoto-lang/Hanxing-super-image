"use client"

import { cn } from "@/lib/utils"

/**
 * Pulse 边框光效（手册 §5.5，参考 Jakub Antalik border-beam 的呼吸式变体）
 *
 * 围绕元素的呼吸式发光边框动画：CSS @property + conic-gradient。
 * 生成中（active）时光效明显，完成时收敛。
 *
 * 性能：纯 CSS（无 framer-motion），低端设备自动降级为静态边框
 * （通过 prefers-reduced-motion）。
 */
export function BorderBeam({
  active = true,
  className,
  size = 220,
  duration = 3,
  color = "oklch(0.65 0.25 250)",
  children,
}: {
  active?: boolean
  className?: string
  size?: number
  duration?: number
  color?: string
  children?: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "relative rounded-lg",
        active ? "pulse-beam-active" : "",
        className,
      )}
      style={
        {
          "--beam-size": `${size}px`,
          "--beam-duration": `${duration}s`,
          "--beam-color": color,
        } as React.CSSProperties
      }
    >
      {active ? (
        <div className="pulse-beam-ring pointer-events-none absolute -inset-[2px] rounded-lg" />
      ) : null}
      <div className="relative z-10">{children}</div>

      <style jsx>{`
        @property --beam-angle {
          syntax: "<angle>";
          inherits: false;
          initial-value: 0deg;
        }
        .pulse-beam-ring {
          background: conic-gradient(
            from var(--beam-angle),
            transparent 0deg,
            var(--beam-color) 60deg,
            transparent 120deg,
            transparent 240deg,
            var(--beam-color) 300deg,
            transparent 360deg
          );
          mask: linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          mask-composite: exclude;
          padding: 2px;
          filter: blur(1px);
          animation: beam-rotate var(--beam-duration) linear infinite;
          opacity: 0.9;
        }
        .pulse-beam-active {
          animation: beam-pulse calc(var(--beam-duration) * 0.6) ease-in-out
            infinite alternate;
        }
        @keyframes beam-rotate {
          to {
            --beam-angle: 360deg;
          }
        }
        @keyframes beam-pulse {
          from {
            filter: brightness(0.85);
          }
          to {
            filter: brightness(1.25);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .pulse-beam-ring {
            animation: none;
            background: var(--beam-color);
            opacity: 0.4;
          }
          .pulse-beam-active {
            animation: none;
          }
        }
      `}</style>
    </div>
  )
}
