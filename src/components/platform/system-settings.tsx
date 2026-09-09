"use client"

import { useState } from "react"
import { Database, Save, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import {
  saveStorageSettingAction,
  type StorageSetting,
} from "@/server/actions/platform-system"

interface SystemSettingsProps {
  initialStorage: StorageSetting
}

export function SystemSettings({ initialStorage }: SystemSettingsProps) {
  const [storage, setStorage] = useState<StorageSetting>(initialStorage)
  const [savingStorage, setSavingStorage] = useState(false)

  const handleSaveStorage = async () => {
    setSavingStorage(true)
    try {
      const res = await saveStorageSettingAction(storage)
      if (res.ok) {
        toast.success(
          res.tested ? "存储设置已保存，COS 连通性验证通过" : "存储设置已保存",
        )
      } else {
        toast.error(res.error ?? "保存失败")
      }
    } catch {
      toast.error("保存失败")
    } finally {
      setSavingStorage(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">系统设置</h1>
        <p className="text-sm text-muted-foreground">
          平台级全局配置（仅超管可操作）
        </p>
      </div>

      {/* 存储配置 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="size-4" />
            存储后端
          </CardTitle>
          <CardDescription>
            切换本地存储 / 腾讯云 COS（COS 单桶，用 ref/ config/ gen/ 文件夹前缀区分文件类型）
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>存储方式</Label>
            <Select
              value={storage.provider}
              onValueChange={(v) =>
                setStorage((prev) => ({
                  ...prev,
                  provider: (v ?? "local") as "local" | "cos",
                }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {storage.provider === "cos" ? "腾讯云 COS" : "本地存储"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">本地存储</SelectItem>
                <SelectItem value="cos">腾讯云 COS</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="local-prefix">本地存储目录前缀</Label>
            <Input
              id="local-prefix"
              value={storage.localImagePrefix}
              onChange={(e) =>
                setStorage((prev) => ({
                  ...prev,
                  localImagePrefix: e.target.value,
                }))
              }
              placeholder="image/"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="allowed-hosts">额外可信下载域名</Label>
            <Textarea
              id="allowed-hosts"
              rows={3}
              value={storage.allowedDownloadHosts.join("\n")}
              onChange={(e) =>
                setStorage((prev) => ({
                  ...prev,
                  allowedDownloadHosts: e.target.value
                    .split(/[\n,，]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                }))
              }
              placeholder={
                "每行一个：精确域名（img.example.com）或以 . 开头的后缀（.example.com）"
              }
            />
            <p className="text-xs text-muted-foreground">
              服务器回拉 AI 上游图片时的防 SSRF 白名单补充。生图报「下载失败:
              目标域名不在可信白名单内」时，在此添加上游图片域名后重试。
            </p>
          </div>

          {storage.provider === "cos" && (
            <div className="space-y-6">
              {/* 共用凭证（一个子账号授权该桶） */}
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="cos-id">COS SecretId</Label>
                  <Input
                    id="cos-id"
                    value={storage.cosSecretId}
                    onChange={(e) =>
                      setStorage((prev) => ({
                        ...prev,
                        cosSecretId: e.target.value,
                      }))
                    }
                    placeholder="子账号 SecretId"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cos-key">COS SecretKey</Label>
                  <Input
                    id="cos-key"
                    type="password"
                    value={storage.cosSecretKey}
                    onChange={(e) =>
                      setStorage((prev) => ({
                        ...prev,
                        cosSecretKey: e.target.value,
                      }))
                    }
                    placeholder="子账号 SecretKey"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cos-region">地域 Region</Label>
                  <Input
                    id="cos-region"
                    value={storage.cosRegion}
                    onChange={(e) =>
                      setStorage((prev) => ({
                        ...prev,
                        cosRegion: e.target.value,
                      }))
                    }
                    placeholder="ap-guangzhou"
                  />
                </div>
              </div>

              {/* 桶（单桶，所有图片都存这里，靠前缀分文件夹） */}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="cos-bucket">Bucket 名称</Label>
                  <Input
                    id="cos-bucket"
                    value={storage.cosBucket}
                    onChange={(e) =>
                      setStorage((prev) => ({
                        ...prev,
                        cosBucket: e.target.value,
                      }))
                    }
                    placeholder="hanxing-1250000000"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cos-url">访问域名 / Base URL</Label>
                  <Input
                    id="cos-url"
                    value={storage.cosBaseUrl}
                    onChange={(e) =>
                      setStorage((prev) => ({
                        ...prev,
                        cosBaseUrl: e.target.value,
                      }))
                    }
                    placeholder="https://hanxing-1250000000.cos.ap-guangzhou.myqcloud.com"
                  />
                </div>
              </div>

              {/* 内网上传/拉取（仅腾讯云同地域服务器可达） */}
              <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                <div className="space-y-1">
                  <Label htmlFor="cos-internal">服务器与 COS 间流量走内网域名</Label>
                  <p className="text-xs text-muted-foreground">
                    仅当应用服务器部署在腾讯云且与 COS 桶同地域时开启（如轻量/CVM
                    广州 + 桶在广州）。上传与服务端拉取（图片代理、转存下载）改走
                    <code className="mx-1 rounded bg-muted px-1">
                      cos.&lt;region&gt;.tencentcos.cn
                    </code>
                    内网域名：免流量费、不占公网出带宽，并避免 COS 公网下行流量费。
                    开启前先在服务器上执行 nslookup 验证内网连通，公网环境开启会导致
                    上传/代理拉取失败。图片展示与浏览器直传不受影响。
                  </p>
                </div>
                <Switch
                  id="cos-internal"
                  checked={storage.cosForceInternalEndpoint}
                  onCheckedChange={(v) =>
                    setStorage((prev) => ({
                      ...prev,
                      cosForceInternalEndpoint: v,
                    }))
                  }
                />
              </div>

              {/* 前缀（与 COS 生命周期规则一一对应） */}
              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="ref-prefix">参考图前缀（会过期）</Label>
                  <Input
                    id="ref-prefix"
                    value={storage.refPrefix}
                    onChange={(e) =>
                      setStorage((prev) => ({
                        ...prev,
                        refPrefix: e.target.value,
                      }))
                    }
                    placeholder="ref/"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="config-prefix">配置图前缀（不过期）</Label>
                  <Input
                    id="config-prefix"
                    value={storage.configPrefix}
                    onChange={(e) =>
                      setStorage((prev) => ({
                        ...prev,
                        configPrefix: e.target.value,
                      }))
                    }
                    placeholder="config/"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gen-prefix">生成图前缀（会过期）</Label>
                  <Input
                    id="gen-prefix"
                    value={storage.generatePrefix}
                    onChange={(e) =>
                      setStorage((prev) => ({
                        ...prev,
                        generatePrefix: e.target.value,
                      }))
                    }
                    placeholder="gen/"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={handleSaveStorage} disabled={savingStorage}>
              {savingStorage ? (
                <MorphingInfinity className="mr-2 size-4" />
              ) : (
                <Save className="mr-2 size-4" />
              )}
              {savingStorage ? "保存中..." : "保存存储设置"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 图片过期与清理（由腾讯云 COS 控制台管理） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4" />
            图片过期与清理
          </CardTitle>
          <CardDescription>
            应用不主动删除任何图片；过期与清理由腾讯云 COS
            控制台的生命周期规则管理，已过期的图片在前端显示「图片已过期」占位。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-muted-foreground">参考图（ref/，会过期）</p>
              <p className="text-lg font-semibold">COS 规则配置</p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-muted-foreground">生成图（gen/，会过期）</p>
              <p className="text-lg font-semibold">COS 规则配置</p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-muted-foreground">配置图（config/）</p>
              <p className="text-lg font-semibold">建议不过期</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            桶内按企业分文件夹：ref/&lt;企业ID&gt;/、gen/&lt;企业ID&gt;/、config/&lt;企业ID
            或 _platform&gt;/。COS 控制台对 ref/、gen/ 前缀各配一条生命周期规则即可覆盖全部企业，详见
            docs/storage-lifecycle.md。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
