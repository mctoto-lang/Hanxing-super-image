"use client"

import * as React from "react"
import { Boxes, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  getMockupSettingAction,
  saveMockupSettingAction,
} from "@/server/actions/platform"

/**
 * 企业级样机渲染服务配置（超管）
 *
 * 每个企业对接各自的 psd-render-api 实例：服务地址 / API Key（AES 加密落库，
 * 留空不修改）/ 渲染单价（积分/样机）/ 启用开关。
 */
export function MockupConfigDialog({
  enterpriseId,
  enterpriseName,
}: {
  enterpriseId: string
  enterpriseName: string
}) {
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [apiBaseUrl, setApiBaseUrl] = React.useState("")
  const [hasApiKey, setHasApiKey] = React.useState(false)
  const [apiKey, setApiKey] = React.useState("")
  const [costPerRender, setCostPerRender] = React.useState(1)
  const [enabled, setEnabled] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    let stop = false
    setLoading(true)
    void getMockupSettingAction(enterpriseId)
      .then((cfg) => {
        if (stop) return
        setApiBaseUrl(cfg.apiBaseUrl)
        setHasApiKey(cfg.hasApiKey)
        setCostPerRender(cfg.costPerRender)
        setEnabled(cfg.enabled)
        setApiKey("")
      })
      .finally(() => {
        if (!stop) setLoading(false)
      })
    return () => {
      stop = true
    }
  }, [open, enterpriseId])

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await saveMockupSettingAction({
        enterpriseId,
        apiBaseUrl,
        apiKey: apiKey || undefined,
        costPerRender,
        enabled,
      })
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success("样机渲染配置已保存")
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Boxes className="size-4" />
            样机渲染
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>样机渲染配置</DialogTitle>
          <DialogDescription>
            「{enterpriseName}」对接的 PSD 渲染服务（各企业可对接独立实例，模板目录相互隔离）
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="mockup-base-url">渲染服务地址</Label>
              <Input
                id="mockup-base-url"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                placeholder="https://psd-render.example.com"
              />
              <p className="text-xs text-muted-foreground">
                psd-render-api 的根地址（如 http://127.0.0.1:3000）
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mockup-api-key">API Key</Label>
              <Input
                id="mockup-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasApiKey ? "已配置（留空不修改）" : "sk_live_…"}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mockup-cost">渲染单价（积分/样机）</Label>
              <Input
                id="mockup-cost"
                type="number"
                min={1}
                value={costPerRender}
                onChange={(e) => setCostPerRender(Number(e.target.value))}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <div className="text-sm font-medium">启用样机渲染</div>
                <div className="text-xs text-muted-foreground">
                  关闭后企业内样机页显示「未开通」，在途任务按失败退款
                </div>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button disabled={saving || loading} onClick={() => void handleSave()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
