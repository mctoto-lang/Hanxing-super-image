"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
} from "react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Slider,
  SliderControl,
  SliderThumb,
  SliderTrack,
} from "@/components/ui/slider"
import {
  hexToRgb,
  hsbToRgb,
  normalizeHex,
  rgbToHex,
  rgbToHsb,
} from "@/lib/color/convert"

/**
 * HSB 取色器(SV 二维选色面板 + 色相滑杆 + HEX/RGB/HSB 格式输入)。
 * 颜色换算复用 @/lib/color/convert(与提示词注入的 HSB 口径一致),
 * 面板对外只收发 6 位 HEX 字符串,不支持 alpha。
 */

/** 面板内部工作状态:h 0-360,s/b 0-100 */
interface HsbState {
  h: number
  s: number
  b: number
}

/** 色值展示/输入格式 */
export type ColorPickerMode = "hex" | "rgb" | "hsb"

const COLOR_PICKER_MODES = ["hex", "rgb", "hsb"] as const

interface ColorPickerContextValue {
  hue: number
  saturation: number
  brightness: number
  /** 当前精确 hex(外部设置的保留原值,避免 HSB 取整回算产生 ±1 漂移) */
  hex: string
  mode: ColorPickerMode
  /** 原子更新 HSB 分量,单次手势只触发一次 onChange */
  setHsb: (next: Partial<HsbState>) => void
  setMode: (mode: ColorPickerMode) => void
}

const ColorPickerContext = createContext<ColorPickerContextValue | undefined>(
  undefined,
)

export function useColorPicker() {
  const context = useContext(ColorPickerContext)
  if (!context) {
    throw new Error("useColorPicker must be used within a ColorPicker")
  }
  return context
}

export type ColorPickerProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "onChange"
> & {
  /** 当前色,6 位 HEX(如 "#1F2A44") */
  value?: string
  defaultValue?: string
  /** 用户拖拽/滑动选色时触发,始终回传大写 #RRGGBB */
  onChange?: (hex: string) => void
}

function hexToHsb(hex: string): HsbState {
  const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 }
  const { h, s, b } = rgbToHsb(rgb)
  return { h, s, b }
}

export function ColorPicker({
  value,
  defaultValue = "#000000",
  onChange,
  className,
  ...props
}: ColorPickerProps) {
  const [hsb, setHsbState] = useState<HsbState>(() =>
    hexToHsb(value ?? defaultValue),
  )
  const [mode, setMode] = useState<ColorPickerMode>("hex")
  const [exactHex, setExactHex] = useState<string>(
    () => normalizeHex(value ?? defaultValue) ?? "#000000",
  )
  // 最近一次向外部发出的 hex,用于区分「外部改动」与「自己发出的回声」
  const lastEmittedRef = useRef<string | null>(null)

  // 外部 value 变化(色库点选/文本输入/图片取色)→ 重新同步面板
  useEffect(() => {
    const next = normalizeHex(value ?? "")
    if (next && next !== lastEmittedRef.current) {
      setHsbState(hexToHsb(next))
      setExactHex(next)
    }
  }, [value])

  const setHsb = useCallback(
    (partial: Partial<HsbState>) => {
      const next = { ...hsb, ...partial }
      setHsbState(next)
      const hex = rgbToHex(hsbToRgb(next))
      lastEmittedRef.current = hex
      setExactHex(hex)
      onChange?.(hex)
    },
    [hsb, onChange],
  )

  return (
    <ColorPickerContext.Provider
      value={{
        hue: hsb.h,
        saturation: hsb.s,
        brightness: hsb.b,
        hex: exactHex,
        mode,
        setHsb,
        setMode,
      }}
    >
      <div className={cn("grid w-full gap-2.5", className)} {...props} />
    </ColorPickerContext.Provider>
  )
}

export type ColorPickerSelectionProps = HTMLAttributes<HTMLDivElement>

/** SV 二维选色面板:横向饱和度、纵向明度(下黑上亮) */
export function ColorPickerSelection({
  className,
  ...props
}: ColorPickerSelectionProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const { hue, saturation, brightness, setHsb } = useColorPicker()

  const applyFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
      setHsb({ s: Math.round(x * 100), b: Math.round((1 - y) * 100) })
    },
    [setHsb],
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!isDragging) return
      applyFromPointer(event.clientX, event.clientY)
    },
    [isDragging, applyFromPointer],
  )

  const stopDragging = useCallback(() => setIsDragging(false), [])

  useEffect(() => {
    if (!isDragging) return
    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", stopDragging)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", stopDragging)
    }
  }, [isDragging, handlePointerMove, stopDragging])

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative aspect-[4/3] w-full touch-none cursor-crosshair rounded-md",
        className,
      )}
      style={{
        background: `linear-gradient(0deg, rgb(0, 0, 0), transparent), linear-gradient(90deg, rgb(255, 255, 255), hsl(${hue}, 100%, 50%))`,
      }}
      onPointerDown={(e) => {
        e.preventDefault()
        setIsDragging(true)
        applyFromPointer(e.clientX, e.clientY)
      }}
      {...props}
    >
      <div
        className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
        style={{
          left: `${saturation}%`,
          top: `${100 - brightness}%`,
          boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.5)",
        }}
      />
    </div>
  )
}

export type ColorPickerHueProps = Pick<HTMLAttributes<HTMLDivElement>, "className">

/** 色相滑杆(0-360,彩虹渐变轨道) */
export function ColorPickerHue({ className }: ColorPickerHueProps) {
  const { hue, setHsb } = useColorPicker()

  return (
    <Slider<number>
      value={hue}
      max={360}
      step={1}
      className={cn("h-4", className)}
      onValueChange={(h) => setHsb({ h: Math.round(h) })}
    >
      <SliderControl>
        <SliderTrack className="h-3 bg-[linear-gradient(90deg,#FF0000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF,#FF0000)]" />
        <SliderThumb aria-label="色相" />
      </SliderControl>
    </Slider>
  )
}

/** 格式切换下拉(HEX / RGB / HSB) */
export function ColorPickerOutput() {
  const { mode, setMode } = useColorPicker()

  return (
    <Select
      value={mode}
      onValueChange={(next) => {
        const match = COLOR_PICKER_MODES.find((m) => m === next)
        if (match) setMode(match)
      }}
    >
      <SelectTrigger
        aria-label="切换颜色格式"
        className="h-8 w-[4.25rem] shrink-0 px-2 text-xs"
      >
        <SelectValue>{mode.toUpperCase()}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {COLOR_PICKER_MODES.map((m) => (
          <SelectItem key={m} value={m} className="text-xs">
            {m.toUpperCase()}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type ChannelIndex = 0 | 1 | 2

function updateAt(arr: string[], index: number, value: string): string[] {
  return arr.map((item, i) => (i === index ? value : item))
}

/**
 * 按当前格式渲染可编辑的色值输入:
 * hex 单框(# 前缀);rgb / hsb 三分量框,改单通道即回写颜色。
 * 草稿本地持有,颜色值变化(拖拽/滑杆/外部点选)时刷新为格式化值。
 */
export function ColorPickerFormat() {
  const { hue, saturation, brightness, hex, mode, setHsb } = useColorPicker()
  const rgb = hsbToRgb({ h: hue, s: saturation, b: brightness })

  const [hexDraft, setHexDraft] = useState(hex.slice(1))
  const [rgbDraft, setRgbDraft] = useState([
    String(rgb.r),
    String(rgb.g),
    String(rgb.b),
  ])
  const [hsbDraft, setHsbDraft] = useState([
    String(hue),
    String(saturation),
    String(brightness),
  ])

  useEffect(() => {
    setHexDraft(hex.slice(1))
    setRgbDraft([String(rgb.r), String(rgb.g), String(rgb.b)])
    setHsbDraft([String(hue), String(saturation), String(brightness)])
  }, [hex]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyHexText = (text: string) => {
    const next = normalizeHex(text)
    if (!next) return
    const { h, s, b } = hexToHsb(next)
    setHsb({ h, s, b })
  }

  const applyRgbChannel = (index: ChannelIndex, raw: string) => {
    const n = Number(raw)
    if (!Number.isFinite(n) || raw.trim() === "") return
    const clamped = Math.min(255, Math.max(0, Math.round(n)))
    const next = { ...rgb }
    if (index === 0) next.r = clamped
    else if (index === 1) next.g = clamped
    else next.b = clamped
    const { h, s, b } = rgbToHsb(next)
    setHsb({ h, s, b })
  }

  const applyHsbChannel = (index: ChannelIndex, raw: string) => {
    const n = Number(raw)
    if (!Number.isFinite(n) || raw.trim() === "") return
    const clamped = Math.min(index === 0 ? 360 : 100, Math.max(0, Math.round(n)))
    const next: HsbState = { h: hue, s: saturation, b: brightness }
    if (index === 0) next.h = clamped
    else if (index === 1) next.s = clamped
    else next.b = clamped
    setHsb(next)
  }

  if (mode === "hex") {
    return (
      <div className="relative flex min-w-0 flex-1 items-center">
        <span className="absolute left-2.5 text-xs text-muted-foreground">
          #
        </span>
        <Input
          value={hexDraft}
          aria-label="HEX 色值"
          onChange={(e) => {
            const next = e.target.value.replace(/#/g, "").slice(0, 6)
            setHexDraft(next)
            applyHexText(next)
          }}
          className="h-8 pl-6 font-mono text-xs uppercase"
        />
      </div>
    )
  }

  const channels =
    mode === "rgb"
      ? [
          {
            key: "r",
            draft: rgbDraft[0],
            on: (v: string) => applyRgbChannel(0, v),
          },
          {
            key: "g",
            draft: rgbDraft[1],
            on: (v: string) => applyRgbChannel(1, v),
          },
          {
            key: "b",
            draft: rgbDraft[2],
            on: (v: string) => applyRgbChannel(2, v),
          },
        ]
      : [
          {
            key: "h",
            draft: hsbDraft[0],
            on: (v: string) => applyHsbChannel(0, v),
          },
          {
            key: "s",
            draft: hsbDraft[1],
            on: (v: string) => applyHsbChannel(1, v),
          },
          {
            key: "b",
            draft: hsbDraft[2],
            on: (v: string) => applyHsbChannel(2, v),
          },
        ]

  return (
    <div className="flex min-w-0 flex-1 gap-1">
      {channels.map((channel, index) => (
        <Input
          key={channel.key}
          value={channel.draft}
          aria-label={`${mode.toUpperCase()} ${channel.key} 分量`}
          inputMode="numeric"
          onChange={(e) => {
            const next = e.target.value
            if (mode === "rgb") setRgbDraft(updateAt(rgbDraft, index, next))
            else setHsbDraft(updateAt(hsbDraft, index, next))
            channel.on(next)
          }}
          className="h-8 min-w-0 flex-1 px-1 text-center font-mono text-xs"
        />
      ))}
    </div>
  )
}
