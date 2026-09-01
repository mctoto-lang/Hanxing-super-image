"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowRight, Rocket } from "lucide-react"
import { cn } from "@/lib/utils"

/** 单颗星：伪 3D 坐标，x/y 为以画布中心为原点的偏移，z 为深度（越小离观察者越近） */
class Star {
  x: number
  y: number
  z: number
  /** 上一帧深度，用于画「上一位置 → 当前位置」的拉伸光轨 */
  pz: number

  constructor(width: number, height: number) {
    this.x = Math.random() * width - width / 2
    this.y = Math.random() * height - height / 2
    this.z = Math.random() * width
    this.pz = this.z
  }

  update(speed: number, width: number, height: number) {
    this.z -= speed
    if (this.z < 1) {
      this.z = width
      this.x = Math.random() * width - width / 2
      this.y = Math.random() * height - height / 2
      this.pz = this.z
    }
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const sx = (this.x / this.z) * (width / 2) + width / 2
    const sy = (this.y / this.z) * (height / 2) + height / 2
    const px = (this.x / this.pz) * (width / 2) + width / 2
    const py = (this.y / this.pz) * (height / 2) + height / 2
    const radius = Math.max(0.1, (1 - this.z / width) * 2.5)
    this.pz = this.z

    ctx.beginPath()
    ctx.moveTo(px, py)
    ctx.lineTo(sx, sy)
    ctx.lineWidth = radius * 2
    ctx.strokeStyle = `rgba(255, 255, 255, ${1 - this.z / width})`
    ctx.stroke()
  }
}

/**
 * 「产品功能」区块：超空间星空画布 + 居中功能文案
 *
 * 改编自 HyperdriveHero 模板（Canvas 伪 3D 星场 + 鼠标越靠近屏幕中心速度越快），
 * 入场动画复用 globals.css 的 animate-fade-slide-in-*，进入视口时才播放，
 * 离开视口时暂停绘制以省性能；prefers-reduced-motion 下退化为静态星空。
 */
export default function StarfieldSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** 区块是否在视口内（控制 rAF 是否实际绘制） */
  const visibleRef = useRef(true)
  const [revealed, setRevealed] = useState(false)

  // 星空画布
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches
    const numStars = window.innerWidth < 768 ? 300 : 800
    let stars: Star[] = []
    let speed = 2
    let rafId: number | null = null

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width
      canvas.height = rect.height
    }

    const initStars = () => {
      stars = Array.from(
        { length: numStars },
        () => new Star(canvas.width, canvas.height),
      )
    }

    const drawFrame = () => {
      // 不清屏而是盖半透明黑，让星星拖出运动光轨
      ctx.fillStyle = "rgba(0, 0, 0, 0.2)"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      for (const star of stars) {
        star.update(speed, canvas.width, canvas.height)
        star.draw(ctx, canvas.width, canvas.height)
      }
    }

    const loop = () => {
      if (visibleRef.current) drawFrame()
      rafId = requestAnimationFrame(loop)
    }

    const drawStatic = () => {
      ctx.fillStyle = "#000"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = "rgba(255, 255, 255, 0.8)"
      for (const star of stars) {
        const sx = (star.x / star.z) * (canvas.width / 2) + canvas.width / 2
        const sy = (star.y / star.z) * (canvas.height / 2) + canvas.height / 2
        ctx.beginPath()
        ctx.arc(sx, sy, 1, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const onMouseMove = (event: MouseEvent) => {
      // 鼠标越靠近屏幕水平中心，飞行速度越快
      const centerX = window.innerWidth / 2
      const dist = Math.abs(event.clientX - centerX)
      const maxDist = window.innerWidth / 2
      speed = 2 + (1 - dist / maxDist) * 20
    }

    const onResize = () => {
      resize()
      initStars()
      if (reduceMotion) drawStatic()
    }

    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("resize", onResize)

    resize()
    initStars()
    if (reduceMotion) {
      drawStatic()
    } else {
      loop()
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("resize", onResize)
    }
  }, [])

  // 进入视口时播放入场动画；同时跟踪可见性以暂停离屏绘制
  useEffect(() => {
    const el = sectionRef.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        visibleRef.current = entry.isIntersecting
        if (entry.isIntersecting) setRevealed(true)
      },
      { threshold: 0.1 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const reveal = (step: 1 | 2 | 3 | 4) =>
    revealed ? `animate-fade-slide-in-${step}` : "opacity-0"

  return (
    <section
      ref={sectionRef}
      id="features"
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black"
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute inset-0 z-0 h-full w-full"
      />

      {/* 上下压暗遮罩：电影感 + 保证文字可读 */}
      <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-t from-black via-transparent to-black" />

      <div className="relative z-20 p-6 text-center">
        <div
          className={cn(
            reveal(1),
            "mb-6 inline-flex items-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-4 py-1.5 backdrop-blur-sm",
          )}
        >
          <Rocket className="h-4 w-4 text-indigo-300" />
          <span className="text-sm font-medium text-gray-200">
            新一代 AI 图像创作平台
          </span>
        </div>

        <h2
          className={cn(
            reveal(2),
            "mb-6 bg-gradient-to-b from-white to-gray-400 bg-clip-text text-5xl font-bold tracking-tighter text-transparent md:text-7xl",
          )}
        >
          极速生成 · 无限创意
        </h2>

        <p
          className={cn(
            reveal(3),
            "mx-auto mb-10 max-w-2xl text-lg text-gray-400",
          )}
        >
          聚合多家前沿 AI
          模型，一句话生成商用级图像。模板库、参考图、批量任务与企业级权限管理，
          让团队创意工作流一步到位。
        </p>

        <div className={reveal(4)}>
          <a
            href="/login"
            className="mx-auto flex w-fit items-center gap-2 rounded-lg bg-white px-8 py-4 font-semibold text-black shadow-lg transition-colors duration-300 hover:bg-gray-200"
          >
            立即体验
            <ArrowRight className="h-5 w-5" />
          </a>
        </div>
      </div>
    </section>
  )
}
