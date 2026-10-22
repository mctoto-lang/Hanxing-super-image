"use client"

import * as React from "react"
import { Loader2, Store } from "lucide-react"
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
  getTemuAppSettingAction,
  saveTemuAppSettingAction,
} from "@/server/actions/platform"

/**
 * 企业级 TEMU 官方开放平台应用配置（超管）
 *
 * 每个企业可对接各自的自研应用：app_key / app_secret（AES 加密落库，
 * 掩码回显、留空不修改）/ testMode（切官方文档测试账号，供正式应用
 * 审批下来前联调）。未配置的企业其店铺同步与 TEMU 工作台不可用。
 */
export function TemuAppConfigDialog({
  enterpriseId,
  enterpriseName,
}: {
  enterpriseId: string
  enterpriseName: string
}) {
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  /** 加载失败：不渲染可保存的空表单，防止假「未配置」态诱导覆盖既有凭证 */
  const [loadError, setLoadError] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [appKey, setAppKey] = React.useState("")
  const [appSecret, setAppSecret] = React.useState("")
  const [hasSecret, setHasSecret] = React.useState(false)
  const [testMode, setTestMode] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    let stop = false
    setLoading(true)
    setLoadError(false)
    void getTemuAppSettingAction(enterpriseId)
      .then((cfg) => {
        if (stop) return
        setAppKey(cfg.appKey)
        setAppSecret(cfg.appSecret)
        setHasSecret(Boolean(cfg.appSecret))
        setTestMode(cfg.testMode)
      })
      .catch(() => {
        if (stop) return
        setLoadError(true)
        toast.error("加载失败，请重试")
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
      const res = await saveTemuAppSettingAction({
        enterpriseId,
        appKey,
        appSecret,
        testMode,
      })
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success("TEMU 应用配置已保存")
      setOpen(false)
    } catch {
      toast.error("保存失败，请重试")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Store className="size-4" />
            TEMU应用
          </Button>
        }
      />
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>TEMU 应用配置</DialogTitle>
          <DialogDescription>
            「{enterpriseName}」对接的 TEMU 官方开放平台自研应用凭证（各企业可使用不同的应用接入）
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> 加载中…
          </div>
        ) : loadError ? (
          <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-destructive">
            配置加载失败，请关闭后重试；为避免覆盖既有凭证，已停用编辑表单。
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="temu-app-key">app_key</Label>
              <Input
                id="temu-app-key"
                value={appKey}
                onChange={(e) => setAppKey(e.target.value)}
                placeholder="TEMU 开放平台自研应用的 app_key"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="temu-app-secret">app_secret</Label>
              <Input
                id="temu-app-secret"
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={hasSecret ? "已配置（掩码提交=不修改，清空并保存=删除）" : "app_secret（仅超管可见）"}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <div className="text-sm font-medium">测试模式</div>
                <div className="text-xs text-muted-foreground">
                  调用时改用官方文档测试账号（全托），供正式应用审批下来前联调；店铺
                  access_token 也须用测试账号的
                </div>
              </div>
              <Switch checked={testMode} onCheckedChange={setTestMode} />
            </div>

            <p className="text-xs text-muted-foreground">
              未配置凭证时，该企业的店铺同步与 TEMU 工作台不可用；凭证与店铺 token
              均加密存储。
            </p>
          </div>
        )}

        <DialogFooter>
          <Button disabled={saving || loading || loadError} onClick={() => void handleSave()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
