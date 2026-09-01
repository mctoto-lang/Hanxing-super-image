"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Pencil, Plus, Power } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  createBannerAction,
  toggleBannerAction,
  updateBannerAction,
} from "@/server/actions/platform-banners"
import {
  BANNER_ICON_OPTIONS,
  type BannerIconName,
} from "@/lib/banner"

export interface BannerRow {
  id: string
  title: string
  content: string
  linkUrl: string | null
  linkLabel: string
  icon: string
  countdownEndsAt: Date | null
  startsAt: Date | null
  endsAt: Date | null
  sortOrder: number
  isActive: boolean
}

/** Date/ISO → datetime-local 输入框值（本地时区，空 = 不限） */
function toLocalInput(v: Date | string | null | undefined): string {
  if (!v) return ""
  const d = typeof v === "string" ? new Date(v) : v
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local 输入值 → ISO 字符串（空 = undefined） */
function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

function BannerForm({ row, onDone }: { row: BannerRow | null; onDone: () => void }) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [title, setTitle] = useState(row?.title ?? "")
  const [content, setContent] = useState(row?.content ?? "")
  const [linkUrl, setLinkUrl] = useState(row?.linkUrl ?? "")
  const [linkLabel, setLinkLabel] = useState(row?.linkLabel ?? "立即查看")
  const [icon, setIcon] = useState<BannerIconName>(
    (row?.icon as BannerIconName) ?? "megaphone",
  )
  const [countdownEndsAt, setCountdownEndsAt] = useState(
    toLocalInput(row?.countdownEndsAt),
  )
  const [startsAt, setStartsAt] = useState(toLocalInput(row?.startsAt))
  const [endsAt, setEndsAt] = useState(toLocalInput(row?.endsAt))
  const [sortOrder, setSortOrder] = useState(row?.sortOrder ?? 0)
  const [isActive, setIsActive] = useState(row?.isActive ?? true)

  const submit = async () => {
    setSubmitting(true)
    try {
      const base = {
        title,
        content,
        linkUrl: linkUrl.trim() || undefined,
        linkLabel: linkLabel.trim() || undefined,
        icon,
        countdownEndsAt: fromLocalInput(countdownEndsAt),
        startsAt: fromLocalInput(startsAt),
        endsAt: fromLocalInput(endsAt),
        sortOrder,
        isActive,
      }
      const res = row
        ? await updateBannerAction({ ...base, id: row.id })
        : await createBannerAction(base)
      if (!res.ok) {
        toast.error(res.error ?? "保存失败")
        return
      }
      toast.success(row ? "横幅已更新" : "横幅已创建")
      onDone()
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>标题</Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="黑五限时大促"
          maxLength={100}
        />
      </div>
      <div className="space-y-1.5">
        <Label>内容文案</Label>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="活动仅限 24 小时，全场 8 折起，不容错过！"
          maxLength={300}
          rows={2}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>跳转链接（站外，可空）</Label>
          <Input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://example.com/promo"
          />
        </div>
        <div className="space-y-1.5">
          <Label>按钮文字</Label>
          <Input
            value={linkLabel}
            onChange={(e) => setLinkLabel(e.target.value)}
            placeholder="立即查看"
            maxLength={50}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>图标</Label>
          <Select
            value={icon}
            onValueChange={(v) => setIcon((v ?? "megaphone") as BannerIconName)}
            items={BANNER_ICON_OPTIONS}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BANNER_ICON_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>排序（小者优先）</Label>
          <Input
            type="number"
            min={0}
            max={9999}
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label>倒计时截止（可空）</Label>
          <Input
            type="datetime-local"
            value={countdownEndsAt}
            onChange={(e) => setCountdownEndsAt(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>投放开始（可空）</Label>
          <Input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>投放结束（可空）</Label>
          <Input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </div>
      </div>
      <label className="flex items-center justify-between rounded-md border p-3">
        <span className="text-sm font-medium">
          启用
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            关闭后横幅不再参与轮换展示
          </span>
        </span>
        <Switch checked={isActive} onCheckedChange={(v) => setIsActive(v)} />
      </label>
      <p className="text-xs text-muted-foreground">
        提示：倒计时到期后横幅自动下线；投放开始/结束留空分别表示立即开始、长期投放。
      </p>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          取消
        </Button>
        <Button onClick={submit} disabled={submitting}>
          {submitting && <MorphingInfinity className="mr-1 size-4" />}
          保存
        </Button>
      </DialogFooter>
    </div>
  )
}

/** 新建横幅 */
export function BannerCreateDialog() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" />
        新建横幅
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>新建广告横幅</DialogTitle>
          <DialogDescription>
            配置内容、倒计时与站外跳转链接，多条横幅将在登录后页面随机轮换展示
          </DialogDescription>
          <BannerForm row={null} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 编辑横幅 */
export function BannerEditButton({ row }: { row: BannerRow }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>编辑横幅：{row.title}</DialogTitle>
          <DialogDescription>
            保存后已关闭该横幅的用户会重新看到它（内容指纹更新）
          </DialogDescription>
          <BannerForm row={row} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** 启用/停用 */
export function BannerToggleActiveButton({
  id,
  isActive,
}: {
  id: string
  isActive: boolean
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={loading}
      onClick={async () => {
        setLoading(true)
        try {
          const res = await toggleBannerAction({ id, isActive: !isActive })
          if (!res.ok) {
            toast.error(res.error ?? "操作失败")
            return
          }
          router.refresh()
        } finally {
          setLoading(false)
        }
      }}
    >
      <Power className="mr-1 size-3.5" />
      {isActive ? "停用" : "启用"}
    </Button>
  )
}
