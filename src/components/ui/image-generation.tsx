"use client"

/**
 * 图像生成加载动画（生成中占位画布）
 *
 * 视觉：深色画布 + 点阵纹理（igDots）+ 双 radial 光斑游走呼吸（igGlow，
 * mask 由 ig-morph 驱动）+ 高光扫过（igCanvas::after，ig-shine）+ 分辨率角标。
 * 样式与 keyframes 定义在 globals.css（搜索「ig-」）。
 */
export function ImageGeneration({
  prompt = "a calm mountain lake at dawn",
  resolution = "1024 × 1024",
  showMeta = true,
  ratio = "1 / 1",
  className,
}: {
  prompt?: string
  /** 画布角标文本（如「1024 × 1024」） */
  resolution?: string
  /** 是否渲染底部 label + 提示词（嵌入网格格子时关闭） */
  showMeta?: boolean
  /** 画布宽高比（CSS aspect-ratio 值），默认 1:1 */
  ratio?: string
  className?: string
}) {
  return (
    <div className={className ? `igWrap ${className}` : "igWrap"}>
      <div
        className="igCanvas"
        role="img"
        aria-label="Generating image"
        style={{ aspectRatio: ratio }}
      >
        <span className="igDots" aria-hidden />
        <span className="igGlow" aria-hidden />
        {resolution ? <span className="igRes">{resolution}</span> : null}
      </div>
      {showMeta ? (
        <div className="igMeta">
          <span className="igLabel">Generating image</span>
          <span className="igPrompt">“{prompt}”</span>
        </div>
      ) : null}
    </div>
  )
}

export default ImageGeneration
