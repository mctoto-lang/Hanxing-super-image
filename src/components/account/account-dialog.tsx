"use client"

import * as React from "react"
import {
  CalendarClock,
  Coins,
  Crown,
  ImageIcon,
  LogOut,
  Pencil,
  UserRound,
  Users,
  Zap,
} from "lucide-react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { MorphingInfinity } from "@/components/ui/morphing-infinity"
import { BadgeIcon, PlanBadge } from "@/components/shared/plan-badge"
import { uploadAvatarImage } from "@/lib/upload/upload-avatar-image"
import {
  changePasswordAction,
  updateMyAvatarAction,
  updateProfileAction,
} from "@/server/actions/settings"
import { logoutAction } from "@/server/actions/auth"
import { listMyTransactionsAction } from "@/server/actions/credits"
import { MODULE_LABELS } from "@/lib/admin/table-filters"
import type { SidebarUser } from "@/components/sidebar/types"
import type { PlanBadgeInfo } from "@/lib/plans/badge"
import { nextGrantAt } from "@/lib/plans/cycle"
import { cn } from "@/lib/utils"

/**
 * 账户管理弹窗（对齐 Lovart 参考图布局）
 *
 * 结构：固定尺寸弹窗（920×600）= 左侧导航栏（「账户管理」标题 + 页签，
 * 无滚动）+ 右侧内容区（页标题固定 + 内容区内部滚动，滚动条隐藏）。
 *
 * 页签：
 *   - 个人主页：账户信息（头像 + 套餐勋章角标 + 字段行）/ 修改密码 / 系统（退出登录）
 *   - 订阅：套餐勋章（图标+文字药丸，配置色）+ 升级按钮 + 积分数字 + 用量流水表（合并原「企业订阅」「积分额度」）
 *
 * 差异约定（已与需求方确认）：积分为 ⚡数字 展示（无饼图）；「升级」按钮仅
 * 提示联系平台管理员（套餐由超管分配）；个人主页保留修改密码。
 */

type TabKey = "profile" | "subscription"

interface TxItem {
  id: string
  type: string
  amount: number
  remark: string | null
  /** 消费来源模块（生图任务 source；AI 对话靠备注前缀；无任务流水为 null） */
  source: string | null
  createdAt: string | Date
}

/** 模块列：source（生图任务）→ 中文；备注前缀识别 AI 对话；其余显示 — */
function moduleLabelOf(t: { source: string | null; remark: string | null }): string {
  if (t.source) return MODULE_LABELS[t.source] ?? t.source
  if (t.remark?.startsWith("AI 对话")) return "AI 对话"
  return "—"
}

function fmtDateTime(v: string | Date): string {
  return new Date(v).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** 字段行（参考图：左标签 muted + 右内容，行间细分隔线） */
function FieldRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2.5 last:border-b-0">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/** 区块小标题（参考图：左对齐半粗） */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-foreground">{children}</h3>
}

export function AccountDialog({
  user,
  creditsBalance,
  userCredits,
  open,
  onOpenChange,
  initialTab = "profile",
}: {
  user: SidebarUser
  /** 企业积分池（超管/无企业为 null） */
  creditsBalance?: number | null
  /** 个人配额 */
  userCredits?: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 打开时落到的页签（侧边栏「积分额度」入口直达订阅方案） */
  initialTab?: TabKey
}) {
  const isEnterpriseUser =
    !user.isSuperAdmin && (!!user.enterpriseName || creditsBalance != null)
  const [tab, setTab] = React.useState<TabKey>(initialTab)

  // 弹窗常驻挂载（open=false 不卸载），每次打开需同步到调用方指定页签
  React.useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])

  const tabs: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
    { key: "profile", label: "个人主页", icon: <UserRound className="size-4" /> },
    ...(isEnterpriseUser
      ? [
          {
            key: "subscription" as TabKey,
            label: "订阅方案",
            icon: <Zap className="size-4" />,
          },
        ]
      : []),
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[600px] gap-0 overflow-hidden p-0 sm:max-w-[920px]"
        showCloseButton
      >
        <div className="flex min-h-0 w-full flex-1 flex-col sm:flex-row">
          {/* 左侧导航栏（参考图：浅色底 + 顶部标题，无滚动） */}
          <nav className="flex shrink-0 flex-col border-b bg-muted/30 sm:w-52 sm:border-b-0 sm:border-r">
            <div className="border-b px-4 py-4">
              <span className="text-sm font-semibold">账户管理</span>
            </div>
            <div className="flex gap-1 overflow-x-auto p-2 sm:flex-1 sm:flex-col sm:overflow-visible">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                    tab === t.key
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>
          </nav>

          {/* 右侧内容区（无页标题，内容区内部滚动，滚动条隐藏） */}
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {tab === "profile" ? (
                <ProfileTab user={user} />
              ) : (
                <SubscriptionTab
                  plan={user.plan}
                  creditsBalance={creditsBalance}
                  userCredits={userCredits}
                />
              )}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- 个人主页 ---------------- */

function ProfileTab({ user }: { user: SidebarUser }) {
  const router = useRouter()
  const initials = (user.name || user.username).slice(0, 1).toUpperCase()

  // 头像上传（上传 → 立即落库 → 刷新侧边栏）
  const [avatar, setAvatar] = React.useState<string | null>(user.avatar ?? null)
  const [avatarUploading, setAvatarUploading] = React.useState(false)
  const avatarInputRef = React.useRef<HTMLInputElement>(null)

  // 资料（昵称 / 邮箱）行内编辑
  const [name, setName] = React.useState(user.name ?? "")
  const [email, setEmail] = React.useState(user.email ?? "")
  const dirty = name !== (user.name ?? "") || email !== (user.email ?? "")
  const [savingProfile, setSavingProfile] = React.useState(false)

  // 修改密码
  const [pwd, setPwd] = React.useState({ current: "", next: "", confirm: "" })
  const [savingPwd, setSavingPwd] = React.useState(false)

  const [loggingOut, setLoggingOut] = React.useState(false)

  async function handleAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) {
      toast.error("请选择图片文件")
      return
    }
    setAvatarUploading(true)
    try {
      const url = await uploadAvatarImage(file)
      const res = await updateMyAvatarAction({ imageUrl: url })
      if (res.ok) {
        setAvatar(url)
        toast.success("头像已更新")
        router.refresh()
      } else {
        toast.error(res.error ?? "保存失败")
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败")
    } finally {
      setAvatarUploading(false)
    }
  }

  async function handleSaveProfile() {
    setSavingProfile(true)
    try {
      const res = await updateProfileAction({
        name: name.trim() || undefined,
        email: email.trim() || undefined,
      })
      if (res.ok) {
        toast.success("资料已更新")
        router.refresh()
      } else {
        toast.error(res.error ?? "更新失败")
      }
    } finally {
      setSavingProfile(false)
    }
  }

  async function handleChangePassword() {
    if (pwd.next.length < 6) {
      toast.error("新密码至少 6 字符")
      return
    }
    if (pwd.next !== pwd.confirm) {
      toast.error("两次输入的新密码不一致")
      return
    }
    setSavingPwd(true)
    try {
      const res = await changePasswordAction({
        currentPassword: pwd.current,
        newPassword: pwd.next,
        confirmPassword: pwd.confirm,
      })
      if (res.ok) {
        toast.success("密码已更新")
        setPwd({ current: "", next: "", confirm: "" })
      } else {
        toast.error(res.error ?? "更新失败")
      }
    } finally {
      setSavingPwd(false)
    }
  }

  async function handleLogout() {
    setLoggingOut(true)
    try {
      await logoutAction()
      toast.success("已退出登录")
      router.push("/login")
      router.refresh()
    } catch {
      toast.error("退出失败，请重试")
      setLoggingOut(false)
    }
  }

  return (
    <div className="space-y-7">
      {/* 账户信息 */}
      <section className="space-y-4">
        <SectionTitle>账户信息</SectionTitle>
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <Avatar className="size-14">
              <AvatarImage src={avatar ?? undefined} alt={user.name} />
              <AvatarFallback className="text-lg">{initials}</AvatarFallback>
            </Avatar>
            {/* 套餐勋章角标（参考图头像右上角小徽章） */}
            {user.plan ? (
              <span
                className={cn(
                  "absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-popover",
                  user.plan.isExpired && "saturate-0 opacity-60",
                )}
                style={{ backgroundColor: user.plan.color }}
                title={user.plan.planName}
              >
                <BadgeIcon iconKey={user.plan.iconKey} color="#ffffff" className="size-3" />
              </span>
            ) : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold">{user.name}</div>
            <div className="truncate text-sm text-muted-foreground">
              {user.email || user.username}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={avatarUploading}
            onClick={() => avatarInputRef.current?.click()}
          >
            {avatarUploading ? (
              <MorphingInfinity className="size-3.5" />
            ) : (
              <ImageIcon className="size-3.5" />
            )}
            更换头像
          </Button>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={handleAvatarFile}
          />
        </div>

        <div>
          <FieldRow label="用户名（登录账号）">
            <span className="font-mono text-sm">{user.username}</span>
          </FieldRow>
          <FieldRow label="昵称">
            <span className="flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 w-56 border-0 bg-transparent px-2 text-right focus-visible:ring-1"
                placeholder="设置昵称"
                maxLength={100}
              />
              <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
            </span>
          </FieldRow>
          <FieldRow label="电子邮箱">
            <span className="flex items-center gap-2">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-8 w-56 border-0 bg-transparent px-2 text-right focus-visible:ring-1"
                placeholder="设置邮箱"
                maxLength={255}
              />
              <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
            </span>
          </FieldRow>
          <FieldRow label="归属企业">
            <span className="text-sm">{user.enterpriseName || "无（超管）"}</span>
          </FieldRow>
          <FieldRow label="角色 / 权限组">
            <span className="text-sm">
              {user.roleLabel}
              {user.groupName ? ` · ${user.groupName}` : ""}
            </span>
          </FieldRow>
          {dirty ? (
            <div className="flex justify-end pt-3">
              <Button
                type="button"
                size="sm"
                disabled={savingProfile}
                onClick={handleSaveProfile}
              >
                {savingProfile ? <MorphingInfinity className="size-3.5" /> : null}
                保存修改
              </Button>
            </div>
          ) : null}
        </div>
      </section>

      {/* 修改密码 */}
      <section className="space-y-3">
        <SectionTitle>修改密码</SectionTitle>
        <div>
          <FieldRow label="当前密码">
            <Input
              type="password"
              value={pwd.current}
              onChange={(e) => setPwd((p) => ({ ...p, current: e.target.value }))}
              className="h-8 w-56 text-right"
              placeholder="输入当前密码"
              autoComplete="current-password"
            />
          </FieldRow>
          <FieldRow label="新密码">
            <Input
              type="password"
              value={pwd.next}
              onChange={(e) => setPwd((p) => ({ ...p, next: e.target.value }))}
              className="h-8 w-56 text-right"
              placeholder="至少 6 字符"
              autoComplete="new-password"
            />
          </FieldRow>
          <FieldRow label="确认新密码">
            <Input
              type="password"
              value={pwd.confirm}
              onChange={(e) => setPwd((p) => ({ ...p, confirm: e.target.value }))}
              className="h-8 w-56 text-right"
              placeholder="再次输入新密码"
              autoComplete="new-password"
            />
          </FieldRow>
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={savingPwd || !pwd.current || !pwd.next || !pwd.confirm}
            onClick={handleChangePassword}
          >
            {savingPwd ? <MorphingInfinity className="size-3.5" /> : null}
            更新密码
          </Button>
        </div>
      </section>

      {/* 系统（参考图底部区块） */}
      <section className="space-y-3">
        <SectionTitle>系统</SectionTitle>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">退出登录</div>
            <div className="text-xs text-muted-foreground">
              当前登录账号：{user.username}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loggingOut}
            onClick={handleLogout}
          >
            <LogOut className="size-3.5" />
            退出登录
          </Button>
        </div>
      </section>
    </div>
  )
}

/* ---------------- 订阅（企业订阅 + 积分额度合并） ---------------- */

function SubscriptionTab({
  plan,
  creditsBalance,
  userCredits,
}: {
  plan: PlanBadgeInfo | null
  creditsBalance?: number | null
  userCredits?: number | null
}) {
  const upcoming = plan
    ? nextGrantAt(
        {
          startsAt: new Date(plan.startsAt),
          expiresAt: new Date(plan.expiresAt),
          lastGrantPeriodEnd: plan.lastGrantPeriodEnd
            ? new Date(plan.lastGrantPeriodEnd)
            : null,
          cycleDays: plan.cycleDays,
        },
        new Date(),
      )
    : null

  // 用量流水：首屏一页（action 单页上限 20 条），滚到表格底部自动续页追加
  const PAGE_SIZE = 20
  const [txs, setTxs] = React.useState<TxItem[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async (p: number) => {
    setLoading(true)
    try {
      const res = await listMyTransactionsAction({ page: p, pageSize: PAGE_SIZE })
      setTxs((prev) =>
        p === 1 ? (res.items as TxItem[]) : [...prev, ...(res.items as TxItem[])],
      )
      setTotal(res.total)
      setPage(p)
    } catch {
      // 静默失败：保留已有数据
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load(1)
  }, [load])

  /** 表内滚动到底（留 40px 提前量）自动加载下一页 */
  function handleRowsScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    if (loading || txs.length >= total) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      void load(page + 1)
    }
  }

  function handleUpgrade() {
    toast.info("套餐由平台管理员分配，如需升级或续费，请联系平台管理员")
  }

  return (
    <div className="space-y-3">
      {/* 套餐勋章（图标+文字药丸，后台配置色）+ 升级按钮（高度/字号与药丸对齐） */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {plan ? (
            <>
              <PlanBadge
                iconKey={plan.iconKey}
                color={plan.color}
                name={plan.planName}
                isExpired={plan.isExpired}
                size="md"
                className="h-9 px-3.5 text-sm"
              />
              {/* 已过期时勋章自带置灰 +「已过期」后缀，不再重复显示状态徽章 */}
              {!plan.isExpired && <Badge>生效中</Badge>}
            </>
          ) : (
            <>
              <Badge variant="secondary" className="h-9 px-3.5 text-sm">
                免费版
              </Badge>
              <Badge variant="outline">未订阅</Badge>
            </>
          )}
        </div>
        <Button type="button" size="lg" className="shrink-0" onClick={handleUpgrade}>
          <Crown className="size-4" />
          升级
        </Button>
      </div>

      {/* 套餐元信息 */}
      {plan ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Coins className="size-3.5" />
            每 {plan.cycleDays} 天发放{" "}
            {plan.creditsPerCycle.toLocaleString("zh-CN")} 积分
          </span>
          <span className="inline-flex items-center gap-1">
            <Users className="size-3.5" />
            {plan.maxMembers ? `人数上限 ${plan.maxMembers} 人` : "人数不限"}
          </span>
          <span className="inline-flex items-center gap-1">
            <CalendarClock className="size-3.5" />
            到期 {fmtDateTime(plan.expiresAt)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Zap className="size-3.5" />
            {upcoming ? `下次发放 ${fmtDateTime(upcoming)}` : "无后续发放"}
          </span>
        </div>
      ) : null}

      {/* 积分数字（参考图 ⚡数字 样式，两级积分并排） */}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-2.5">
          <Zap className="size-5 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="text-2xl font-bold tabular-nums">
              {(userCredits ?? 0).toLocaleString("zh-CN")}
            </div>
            <div className="text-xs text-muted-foreground">个人积分</div>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-2.5">
          <Coins className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="text-2xl font-bold tabular-nums">
              {(creditsBalance ?? 0).toLocaleString("zh-CN")}
            </div>
            <div className="text-xs text-muted-foreground">企业积分池</div>
          </div>
        </div>
      </div>

      {/* 用量流水表：表头固定，行区内部滚动（单屏约 6 条，滚动条隐藏） */}
      <section className="space-y-2">
        <SectionTitle>用量</SectionTitle>
        <div className="overflow-hidden rounded-lg border">
          <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1">明细</span>
            <span className="w-20 shrink-0">模块</span>
            <span className="w-32 shrink-0 text-right">日期</span>
            <span className="w-20 shrink-0 text-right">积分变动</span>
          </div>
          {loading && txs.length === 0 ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-8 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          ) : txs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              暂无积分流水记录
            </p>
          ) : (
            <div
              className="scrollbar-hide max-h-[328px] divide-y overflow-y-auto"
              onScroll={handleRowsScroll}
            >
              {txs.map((t) => (
                <div key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span
                    className="min-w-0 flex-1 truncate text-muted-foreground"
                    title={t.remark ?? ""}
                  >
                    {t.remark || "—"}
                  </span>
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">
                    {moduleLabelOf(t)}
                  </span>
                  <span className="w-32 shrink-0 text-right text-xs text-muted-foreground">
                    {fmtDateTime(t.createdAt)}
                  </span>
                  <span
                    className={cn(
                      "w-20 shrink-0 text-right font-medium tabular-nums",
                      t.amount >= 0 ? "text-emerald-500" : "text-destructive",
                    )}
                  >
                    {t.amount >= 0 ? "+" : ""}
                    {t.amount.toLocaleString("zh-CN")}
                  </span>
                </div>
              ))}
              {loading ? (
                <div className="py-2 text-center text-xs text-muted-foreground">
                  加载中…
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
