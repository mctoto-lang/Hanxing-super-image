"use client"

import { useCallback, useEffect, useRef } from "react"

/**
 * 输入栏草稿本地缓存（浏览器 localStorage）。
 *
 * 组件在切换会话、输入栏收起/展开、新对话↔会话切换时都会重挂载，
 * 本地 state 全部归零；草稿落盘后挂载时恢复，输入内容与模型/尺寸/数量
 * 选择跨重挂载（含刷新页面）保留。null 字段 = 从未存储过。
 */
const INPUT_DRAFT_STORAGE_KEY = "create:input-draft"

export interface InputDraft {
  modelId: string | null
  imageSize: string | null
  imageCount: number | null
  referenceImages: string[] | null
  text: string
}

const EMPTY_DRAFT: InputDraft = {
  modelId: null,
  imageSize: null,
  imageCount: null,
  referenceImages: null,
  text: "",
}

export function loadInputDraft(): InputDraft {
  if (typeof window === "undefined") return EMPTY_DRAFT
  try {
    const raw = localStorage.getItem(INPUT_DRAFT_STORAGE_KEY)
    if (!raw) return EMPTY_DRAFT
    return { ...EMPTY_DRAFT, ...JSON.parse(raw) }
  } catch {
    return EMPTY_DRAFT
  }
}

function saveInputDraft(draft: InputDraft) {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(INPUT_DRAFT_STORAGE_KEY, JSON.stringify(draft))
  } catch {
    // 存储满/隐私模式静默失败
  }
}

/**
 * 草稿持久化 hook：防抖合并写入 + 卸载/pagehide 前落盘。
 *
 * - scheduleDraftSave(patch)：多个触发点（配置 state / 文本 onChange /
 *   prefill）的 patch 先累积，400ms 后与已存草稿 read-merge-write，互不覆盖；
 * - flushDraftSave(patch)：立即落盘（先合并 pending patch 再叠加显式 patch，
 *   提交成功清空文本用）。
 *
 * 卸载/页面卸载前落盘 pending 补丁：上滑收起卸载组件、或浏览器刷新/关闭时，
 * 防抖窗口内尚未写入的最后操作（如删参考图后立刻刷新）会丢失，重新打开时
 * 表现为已删除内容"复活"。React 的卸载 cleanup 不会在浏览器 unload 时执行，
 * 需额外监听 pagehide。StrictMode 假卸载无 pending 补丁，落盘幂等无害。
 */
export function useInputDraft() {
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftPatchRef = useRef<Partial<InputDraft>>({})

  const scheduleDraftSave = useCallback((patch: Partial<InputDraft>) => {
    draftPatchRef.current = { ...draftPatchRef.current, ...patch }
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      saveInputDraft({ ...loadInputDraft(), ...draftPatchRef.current })
      draftPatchRef.current = {}
    }, 400)
  }, [])

  const flushDraftSave = useCallback((patch: Partial<InputDraft> = {}) => {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    saveInputDraft({
      ...loadInputDraft(),
      ...draftPatchRef.current,
      ...patch,
    })
    draftPatchRef.current = {}
  }, [])

  useEffect(() => {
    const onPageHide = () => flushDraftSave()
    window.addEventListener("pagehide", onPageHide)
    return () => {
      window.removeEventListener("pagehide", onPageHide)
      flushDraftSave()
    }
  }, [flushDraftSave])

  return { scheduleDraftSave, flushDraftSave }
}
