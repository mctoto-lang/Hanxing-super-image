"use client"

import { useState } from "react"
import { Database, Save, Settings, Clock } from "lucide-react"
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
  saveQueueSettingAction,
  type StorageSetting,
  type QueueSetting,
} from "@/server/actions/platform-system"
import { IMAGE_RETENTION } from "@/lib/storage/config"

interface SystemSettingsProps {
  initialStorage: StorageSetting
  initialQueue: QueueSetting
}

export function SystemSettings({
  initialStorage,
  initialQueue,
}: SystemSettingsProps) {
  const [storage, setStorage] = useState<StorageSetting>(initialStorage)
  const [queue, setQueue] = useState<QueueSetting>(initialQueue)
  const [savingStorage, setSavingStorage] = useState(false)
  const [savingQueue, setSavingQueue] = useState(false)

  const handleSaveStorage = async () => {
    setSavingStorage(true)
    try {
      const res = await saveStorageSettingAction(storage)
      if (res.ok) {
        toast.success("存储设置已保存")
      } else {
        toast.error(res.error ?? "保存失败")
      }
    } catch {
      toast.error("保存失败")
    } finally {
      setSavingStorage(false)
    }
  }

  const handleSaveQueue = async () => {
    setSavingQueue(true)
    try {
      const res = await saveQueueSettingAction(queue)
      if (res.ok) {
        toast.success("队列参数已保存")
      } else {
        toast.error(res.error ?? "保存失败")
      }
    } catch {
      toast.error("保存失败")
    } finally {
      setSavingQueue(false)
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

              {/* 内网上传（仅腾讯云同地域服务器可达） */}
              <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                <div className="space-y-1">
                  <Label htmlFor="cos-internal">服务器上传走内网域名</Label>
                  <p className="text-xs text-muted-foreground">
                    仅当应用服务器部署在腾讯云且与 COS 桶同地域时开启（如轻量/CVM
                    广州 + 桶在广州）。上传改走
                    <code className="mx-1 rounded bg-muted px-1">
                      cos.&lt;region&gt;.tencentcos.cn
                    </code>
                    内网域名：免流量费、不占公网出带宽。开启前先在服务器上执行
                    nslookup 验证内网连通，公网环境开启会导致上传全部失败。图片展示与浏览器直传不受影响。
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

      {/* 图片保留策略（固定值，不可配置） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4" />
            图片保留策略
          </CardTitle>
          <CardDescription>
            保留策略为固定值，由腾讯云 COS 生命周期规则执行删除；前端对已删除
            的图片显示「图片已过期」占位。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-muted-foreground">参考图（ref/）</p>
              <p className="text-lg font-semibold">
                {IMAGE_RETENTION.referenceRetainDays} 天
              </p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-muted-foreground">生成图（gen/，含缩略图）</p>
              <p className="text-lg font-semibold">
                {IMAGE_RETENTION.generateRetainDays} 天
              </p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-muted-foreground">配置图（config/）</p>
              <p className="text-lg font-semibold">永不过期</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            调整保留期需同步修改代码常量 IMAGE_RETENTION 与 COS 生命周期规则，
            见 docs/storage-lifecycle.md。
          </p>
        </CardContent>
      </Card>

      {/* 队列配置 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings className="size-4" />
            队列参数
          </CardTitle>
          <CardDescription>
            全局队列轮询间隔、企业并发上限、任务超时时间
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="poll-interval">轮询间隔（毫秒）</Label>
              <Input
                id="poll-interval"
                type="number"
                min={500}
                step={500}
                value={queue.pollIntervalMs}
                onChange={(e) =>
                  setQueue((prev) => ({
                    ...prev,
                    pollIntervalMs: Number(e.target.value) || 2000,
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="max-concurrent">企业并发上限</Label>
              <Input
                id="max-concurrent"
                type="number"
                min={1}
                max={20}
                value={queue.maxConcurrentPerEnterprise}
                onChange={(e) =>
                  setQueue((prev) => ({
                    ...prev,
                    maxConcurrentPerEnterprise:
                      Number(e.target.value) || 5,
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="timeout">任务超时（秒）</Label>
              <Input
                id="timeout"
                type="number"
                min={30}
                step={30}
                value={queue.taskTimeoutSec}
                onChange={(e) =>
                  setQueue((prev) => ({
                    ...prev,
                    taskTimeoutSec: Number(e.target.value) || 120,
                  }))
                }
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSaveQueue} disabled={savingQueue}>
              {savingQueue ? (
                <MorphingInfinity className="mr-2 size-4" />
              ) : (
                <Save className="mr-2 size-4" />
              )}
              {savingQueue ? "保存中..." : "保存队列设置"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
