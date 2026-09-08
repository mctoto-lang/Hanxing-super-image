"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

/**
 * Base UI Slider 封装。
 * 结构:Slider(Root) > SliderControl > [SliderTrack > SliderRange, SliderThumb]
 * Thumb 由库按值绝对定位,SliderControl 必须保持 relative。
 */

function Slider<Value extends number | readonly number[]>({
  className,
  ...props
}: SliderPrimitive.Root.Props<Value>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        "relative flex w-full touch-none items-center select-none data-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

function SliderControl({
  className,
  ...props
}: SliderPrimitive.Control.Props) {
  return (
    <SliderPrimitive.Control
      data-slot="slider-control"
      className={cn(
        "relative flex h-4 w-full touch-none items-center",
        className
      )}
      {...props}
    />
  )
}

function SliderTrack({
  className,
  ...props
}: SliderPrimitive.Track.Props) {
  return (
    <SliderPrimitive.Track
      data-slot="slider-track"
      className={cn(
        "relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/15",
        className
      )}
      {...props}
    />
  )
}

function SliderRange({
  className,
  ...props
}: SliderPrimitive.Indicator.Props) {
  return (
    <SliderPrimitive.Indicator
      data-slot="slider-range"
      className={cn("absolute h-full rounded-full bg-primary", className)}
      {...props}
    />
  )
}

function SliderThumb({
  className,
  ...props
}: SliderPrimitive.Thumb.Props) {
  return (
    <SliderPrimitive.Thumb
      data-slot="slider-thumb"
      className={cn(
        "block size-4 shrink-0 rounded-full border border-primary/50 bg-background shadow-sm outline-none focus-visible:ring-4 focus-visible:ring-primary/30",
        className
      )}
      {...props}
    />
  )
}

export {
  Slider,
  SliderControl,
  SliderTrack,
  SliderRange,
  SliderThumb,
}
