"use client"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"
import type { BatchGenerationLanguage } from "@/lib/workspace/types"

interface LanguageSummary {
  requiresLanguageSelection: boolean
  primaryCount: number
  fallbackCount: number
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  action: string
  count: number
  onConfirm: () => void
  generationLanguage?: BatchGenerationLanguage
  languageSummary?: LanguageSummary
  onLanguagePreferenceChange?: (language: BatchGenerationLanguage) => void
}

export function BatchConfirmDialog({
  open,
  onOpenChange,
  action,
  count,
  onConfirm,
  generationLanguage,
  languageSummary,
  onLanguagePreferenceChange,
}: Props) {
  const isDeleteAction = action === "批量删除"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle
              className={
                isDeleteAction
                  ? "h-4 w-4 text-destructive"
                  : "h-4 w-4 text-amber-500"
              }
            />
            {isDeleteAction ? "确认删除" : "确认操作"}
          </DialogTitle>
        </DialogHeader>
        {isDeleteAction ? (
          <div className="space-y-2 py-2 text-sm text-muted-foreground">
            <p>
              将永久删除选中的{" "}
              <span className="text-foreground font-medium">{count}</span>{" "}
              张卡片，此操作无法恢复。
            </p>
            <p>请确认是否继续删除。</p>
          </div>
        ) : (
          <div className="space-y-4 py-2 text-sm text-muted-foreground">
            <p>
              确认对{" "}
              <span className="text-foreground font-medium">{count}</span> 张卡片执行「
              {action}」操作？
            </p>
            {generationLanguage &&
              languageSummary?.requiresLanguageSelection && (
                <div className="space-y-3">
                  <p className="font-medium text-foreground">生成语言优先级</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant={generationLanguage === "zh" ? "default" : "outline"}
                      onClick={() => onLanguagePreferenceChange?.("zh")}
                    >
                      中文优先
                    </Button>
                    <Button
                      variant={generationLanguage === "en" ? "default" : "outline"}
                      onClick={() => onLanguagePreferenceChange?.("en")}
                    >
                      英文优先
                    </Button>
                  </div>
                  <p>
                    {generationLanguage === "zh"
                      ? `将使用中文生成 ${languageSummary.primaryCount} 张；${languageSummary.fallbackCount > 0 ? `无中文时使用英文 ${languageSummary.fallbackCount} 张。` : ""}`
                      : `将使用英文生成 ${languageSummary.primaryCount} 张；${languageSummary.fallbackCount > 0 ? `${languageSummary.fallbackCount} 张无有效英文译文，将自动使用中文。` : ""}`}
                  </p>
                </div>
              )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant={isDeleteAction ? "destructive" : "default"}
            onClick={onConfirm}
          >
            {isDeleteAction ? "确认删除" : "确认"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
