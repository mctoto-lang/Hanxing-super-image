# 前端 UX/UI 优化建议报告

> 审计范围：全部前端路由（营销 / 认证 / 业务 / 企业管理 / 平台管理）、核心组件交互、UI 基础设施
> 审计日期：2026-09-22 ｜ 本报告只提建议，不改动代码
> 建议分级：**P0 快速修复**（小改动大收益，不动架构）→ **P1 体验升级**（结构性补强）→ **P2 效率打磨**（对标一线产品的进阶能力）

> **实施进度（2026-09-22 更新）**：P0 全部 8 项 ✅、P1 全部 4 项 ✅、P2 已实施 命令面板/toast 撤销/示例 prompt/CSV 导出/细节清理 ✅。
> P2 未实施（后续迭代）：Temu 自由日期范围与列排序、`top-16` 布局变量化、empty 组件全量推广、i18n、workspace-client 组件拆分。
> 验证：tsc / eslint（0 错误）/ vitest 357 通过 / next build 生产构建通过。

---

## 一、总体评价

### 做得好的（应保持）

- **设计系统底座扎实**：shadcn/ui v4（base-nova 风格，@base-ui/react 原语）+ Tailwind v4 CSS-first 配置 + oklch 语义 token 双主题（`src/app/globals.css`），暗色模式经 next-themes 统一管理；sonner toast 做了完整的主题变量映射。
- **`/create` 核心创作流打磨细致**：草稿 localStorage 持久化（防抖 + pagehide 落盘）、积分预估环、中文输入法 composing 判断、新消息防闪烁滚动、收藏乐观更新 + 失败回滚、下载带进度与自动重试、`document.hidden` 暂停轮询、`prefers-reduced-motion` 全面降级。
- **信息架构清晰**：营销 / 认证 / 业务 / 企业 / 平台五层路由组，权限驱动的侧边栏动态裁剪。
- **组件复用率高**：admin 14/14、workspace 16/16、superadmin 32/35、mockup 17/18 全量复用共享 `ui/` 原语；Temu 模块同样基于共享组件，风格并不割裂。

### 核心短板（本报告主线）

1. **交互流程细节摩擦**：上传无拖拽/粘贴、切模型静默清空参考图、跨页无生成完成通知、逐张下载。
2. **资产管理能力缺口**：图库 200 条硬上限、无服务端分页、无批量操作；Temu 表格无排序/导出。
3. **一致性问题**：无权限三种处理方式并存、死路由、标题映射缺失、3 处原生 `confirm()`。
4. **效率工具缺失**：无命令面板、无快捷键体系、无 undo 撤销、无新手引导——这是与一线主流产品差距最大的地方。
5. **移动端**：三大核心工作区（/create、/chat、/workspace）左栏固定 280px 无响应式断点，移动端基本不可用。

---

## 二、P0 快速修复（8 项，小改动大收益）

### P0-1 主创作流上传增强 + 统一上传组件

**现状问题**
- 主创作流仅支持点击 `@` 选文件——**无拖拽、无粘贴**（全库 grep 无 `onPaste`），上传为串行 `for..of await`，无逐文件进度、无取消（`src/components/create/create-prompt-input.tsx:236-297`）。
- **前后端上限不一致**：前端 10MB（`create-prompt-input.tsx:38`）vs 服务端 20MB（`src/lib/upload/limits.ts:10`），合法文件会被前端误拒。
- 项目里存在**两套能力不对等的参考图上传组件**：`reference-image-upload.tsx`（product 等页用）有拖拽 + 8192px 真实尺寸校验但白名单不含 GIF；创作流组件反之。用户在不同模块遇到的规则不同。

**对标主流做法**
- ChatGPT / Discord / Slack：**剪贴板粘贴即传**（截图直接 Ctrl+V），拖拽文件到输入框即传。
- Notion / 飞书：并行上传，每个附件独立进度条，单张失败可重试。

**建议**
1. 合并为一个统一上传组件，同时支持**点击 + 拖拽 + 粘贴**三通道（拖拽区高亮反馈直接复用 `reference-image-upload.tsx:142-152` 的现成实现）。
2. 统一上限为服务端的 20MB 与同一份格式白名单（含 GIF），像素校验（≤8192px）统一下沉到共享工具函数。
3. 上传改并行（`Promise.all`），每张缩略图叠加进度环，支持单张失败重试与移除。

### P0-2 切换模型防误清参考图

**现状问题**：`handleModelChange` 切换模型时**无任何确认直接 `setReferenceImages([])`**（`create-prompt-input.tsx:223-234`）。用户上传多张参考图后误触切换，全部丢失且无法恢复。

**对标主流做法**：破坏性操作必须确认或可挽回（Figma/Photoshop 切工具从不静默丢弃用户资产）。

**建议**：检测到已有参考图且新模型与参考图能力不兼容时，弹统一确认弹窗："切换模型将清空 N 张参考图，是否继续？"；若新旧模型都支持参考图则自动保留，仅重置不兼容的尺寸/数量参数。

### P0-3 无权限页面统一

**现状问题**：同一类"无权限"场景存在三种处理——
- `/chat`（`chat/page.tsx:29-31`）、`/templates`（`templates/page.tsx:9-11`）：直接 `throw FORBIDDEN`，用户在错误边界看到原始英文串 `FORBIDDEN: 无权访问该模块（chat）`；
- `/temu`（`temu/page.tsx:79-83`）：友好中文文案；
- `/platform`、`/admin`：403。

**对标主流做法**：所有 SaaS 的 403 都是统一的品牌化页面：说明原因 + 返回首页按钮 + "联系管理员开通"指引。

**建议**：新建 `src/components/shared/no-permission.tsx`（复用现有 `PageError` 视觉风格），所有模块守卫统一改为渲染该组件，文案注明模块名与开通路径。

### P0-4 死路由与顶栏标题修复

**现状问题**
- `/settings` 是死路由，`redirect("/")` 落到营销首页（`src/app/(dashboard)/settings/page.tsx:8`），而 `sidebar-data.ts:28` 仍保留映射——老书签/外链会莫名跳到落地页。
- 顶栏标题映射缺失新路由：`/platform/product-directions`、`/platform/size-specs`、`/platform/weartry-config/*` 回退显示"数据看板"（`src/components/sidebar/dashboard-header-title.tsx:19-45`）。

**建议**：`/settings` 改为重定向到 `/create` 并自动打开"账户管理"弹窗（或直接 404）；补全标题映射表；建立"新增路由必须登记标题"的约定（可加注释或 lint 检查）。

### P0-5 宽表格横向滚动 + 替换原生 confirm

**现状问题**
- Temu 商品表 12 列宽表**无 `overflow-x-auto` 包裹**（`src/app/(dashboard)/temu/page.tsx:398-457`，`products-table.tsx` 0 命中），窄屏直接溢出。
- 3 处原生 `confirm()` 与全站 Dialog 风格割裂：`mockup/batch-client.tsx:497`、`temu/store-manager.tsx:263、268`；店铺管理还有手写 fixed 弹层（无焦点陷阱、无 aria，`store-manager.tsx:54-74`），操作结果只显示内联红字、复制 Token 按钮无成功反馈。

**对标主流做法**：宽表横向滚动 + sticky 首列是数据面板标配（Shopify Analytics、阿里后台）；确认弹窗全站一套组件（视觉、焦点管理、危险操作红色态一致）。

**建议**：宽表统一包 `overflow-x-auto` 容器；全部原生 `confirm()` 与手写弹层替换为现有 `shared/confirm-dialog.tsx`（项目里已有，直接用）；操作结果统一走 toast。

### P0-6 "下载全部" + 统一下载器

**现状问题**
- 生成结果只能**逐张 hover 下载**（`task-detail-card.tsx:485-491`），一批 4 张图要点 4 次。
- 图库卡片下载用 `a[href].click()` 直下（`image-gallery.tsx:308-315`），绕过了全局 `downloadImageFile`（XHR 代理 + 进度百分比 toast + 失败重试，`task-detail-card.tsx:87-128`）——同一产品两种下载体验。

**建议**：任务卡片操作行增加"下载全部"（可多图合并 zip 或顺序下载）；图库下载全部改走 `downloadImageFile`，进度与失败反馈对齐。

### P0-7 触屏可达性

**现状问题**：图片格的下载/放大按钮、提示词完整浮层均为 `opacity-0 group-hover` 纯鼠标触发（`task-detail-card.tsx:388-394, 486`），触屏设备无法触达。

**对标主流做法**：Midjourney 移动版图片操作常显或点击图片后浮现；移动端普遍改为"点击进入查看器，操作在查看器工具栏"。

**建议**：用 `@media (hover: none)` 或 `use-mobile` 判定触屏时操作按钮常显（降低透明度而非隐藏）；或统一引导进 `ImageViewer` 完成操作（查看器本身已支持触控手势则只需补工具栏触达）。

### P0-8 登录页死按钮处理

**现状问题**：注册 / 忘记密码 / 三个第三方登录按钮视觉上可点，实际全部只弹 toast"暂未开放"（`login-form.tsx:74-84, 107-135`）。次要问题：登录页品牌图与营销页 logo 硬编码了两个不同 CDN 域名（supabase vs COS，`landing-page.tsx:12-15` vs `login-form.tsx:14`）。

**对标主流做法**：未开放的功能应 `disabled` + 灰态 + tooltip 说明（或干脆隐藏），不制造"点了没反应/只有提示"的挫败感。

**建议**：死按钮统一改禁用态并注明"联系管理员开通"；品牌资源统一走同一 CDN 配置。

---

## 三、P1 体验升级（结构性补强）

### P1-1 全局任务通知（跨页感知生成完成）

**现状问题**：任务轮询挂在页面组件上（`create-prompt-input.tsx:376`），切到其他模块轮询即卸载——用户在别的页面完全不知道图生成好了；超时仅提示"请稍后刷新页面查看结果"（`use-task-polling.ts:32`）。会话级轮询 4s 无次数上限（`conversation-detail.tsx:93-107`），状态变化靠整页 `router.refresh()` 全量重跑 RSC。

**对标主流做法**
- Vercel：部署进行中全局顶栏指示，完成时浏览器通知 + 徽标变化。
- ChatGPT 后台任务 / GitHub Actions：切走页面任务照跑，回来或收到通知时结果已就绪。

**建议**：把任务轮询提升为 DashboardShell 层的全局 `TaskStatusProvider`（注册任务 → 全局轮询 → 完成时全局 toast + 浏览器 Notification API），侧边栏对应模块加进行中/完成徽标。已有 `src/hooks/use-polling.ts`（含 hidden 跳过、重入保护）可直接复用。

### P1-2 资产库升级（分页 + 批量操作）

**现状问题**：`listAssetsAction({ limit: 200 })` 一次性硬上限（`src/app/(assets-fixed)/assets/page.tsx:11`），更早的历史资产**永远无法触达**；过滤纯客户端；排序固定时间倒序无切换；无多选、无批量下载/删除/收藏。客户端渐进渲染（首批 60 + IntersectionObserver 哨兵 600px，`image-gallery.tsx:176-210`）倒是做得不错，应保留。

**对标主流做法**
- Google Photos / Midjourney 图库：无限滚动（服务端游标分页）、多选模式 + 底部浮动批量操作栏、排序切换、批量下载打包 ZIP。
- 本项目 `workspace/export` 已有 ZIP 打包能力，可直接复用。

**建议**：action 改游标分页（按 id/createdAt cursor），滚动到底自动加载下一页；新增多选模式（长按或"选择"按钮进入），浮动操作栏提供批量下载（ZIP）/收藏/删除；筛选条件（来源/关键词/日期/收藏）提升到 URL searchParams 实现可分享、可后退。

### P1-3 移动端适配三大工作区

**现状问题**：`/create`（`create-app.tsx:56`）、`/chat`（`chat-app.tsx:232`）、`/workspace`（`workspace-client.tsx:103, 1769`）左栏固定 280px，**0 个响应式断点**——移动端核心功能不可用。侧边栏本身已有 Sheet 化（`use-mobile.ts` 768 断点），但工作区内二级栏没有。

**对标主流做法**：ChatGPT 移动版——会话列表收进抽屉，主内容全宽，顶栏汉堡唤出。

**建议**：三个页面左栏在 `< lg` 断点改为 Sheet 抽屉（复用 shadcn sidebar/Sheet 现成机制），顶栏加会话列表按钮；`/workspace` 工具面板移动端改为底部抽屉或可折叠区。

### P1-4 进度反馈与多步弹窗精简

**现状问题**
- 生成中只有点阵动画占位，**无排队位置/预计时间**（`task-detail-card.tsx:522-533`）。
- 批量导出弹窗要 4 步（confirm → format → exporting → done，`export-dialog.tsx:41`）；新建批量任务 2 步（`new-task-dialog.tsx:41-42`）。
- workspace 有 4 路并行轮询对账 + `IMAGES_RESYNC_COOLDOWN_MS` 等防御代码（`workspace-client.tsx:107-108`），同步失败的表现是卡片图片"迟到"而非明确反馈。

**对标主流做法**：Midjourney 显示队列中排位；主流导出弹窗一屏完成（格式选择与确认同屏，进度直接渲染在按钮上，done 态自动关闭）。

**建议**：轮询接口附带队列位置（后端 queue 已有信息则透出）；导出弹窗合并为单屏 + 内联进度；workspace 同步异常时给明确的"部分图片同步失败，点击重试"提示条。

---

## 四、P2 效率打磨（对标一线产品）

### P2-1 命令面板（Cmd+K）+ 快捷键体系

**现状**：无 cmdk 组件；`onKeyDown` 仅 11 个文件；全局快捷键仅 Enter 提交、查看器 ←/→/Esc。

**对标**：Linear / Vercel / Notion 的 Cmd+K 已是肌肉记忆标配——全局跳转页面、切换会话、选模型、触发下载；`?` 呼出快捷键表；`/` 聚焦搜索。shadcn 生态有现成 command 组件，开发成本低、感知收益大。

### P2-2 删除类操作 toast 撤销（undo）

**现状**：`toast.error` 约为 `toast.success` 的 2 倍，无 `toast.promise`、无 `action:` 撤销；所有删除都靠二次确认弹窗且文案写明"此操作不可撤销"。

**对标**：Gmail / Linear——删除后底部 toast 带"撤销"按钮（延迟执行或软删除），把确认弹窗的打断变成事后可挽回，操作流畅度质变。sonner 原生支持 `action` 按钮，实现成本低。

### P2-3 Temu 数据面板增强

**现状**：日期口径只有固定窗口（今日/近7/近30）且是纯客户端 state（不进 URL，刷新丢失，与店铺切换的 URL 驱动不一致）；表格无列排序、无导出；加载更多失败静默吞掉（`products-table.tsx:342-344` 空 catch）。

**对标**：Shopify Analytics——自由日期范围选择器（项目已有 react-day-picker 可复用）、列头点击排序、一键 CSV 导出、加载失败明确提示。

### P2-4 新手引导与空状态行动化

**现状**：新用户登录直接落 `/create`，只有一段欢迎文案；无示例任务、无功能巡礼；通用 `ui/empty.tsx` 组件仅 1 处使用，空状态多为散落的灰色文案。

**对标**：主流 AI 工具空态即引导——Midjourney/即梦在空输入框下给可点击的示例 prompt 一键填入；Notion 首次进入有 3 步引导卡。

**建议**：`/create` 空态给 3-5 个高质量示例 prompt（点击即填入）；图库空态给"去创作"按钮；推广统一 `empty` 组件。

### P2-5 细节清理清单

| 项 | 位置 | 建议 |
|---|---|---|
| 硬编码 hex 与 chart token 混用 | `temu/products-table.tsx:248`（同段混用 `var(--chart-2/5)` 与 `"#eab308"`/`"#ef4444"`）等 12 文件 | 统一换语义 token |
| `top-16` 硬编码顶栏高度 | `create/page.tsx:52`、`chat/page.tsx:64`、`temu/page.tsx:114`、`workspace-client.tsx:1766` | 提取布局变量/CSS 变量，AdBanner 高度变化即错位 |
| 死依赖 `@tanstack/react-table` | `package.json`（src 下零引用） | 移除，或真正启用它统一 14 处手写表格 |
| 鼠标表情球默认开启 | `nav-user.tsx:82` | 办公场景干扰，建议默认关闭 |
| 失败占位格固定 1:1 | `task-detail-card.tsx:511-520` | 与批内基准比例对齐 |
| 会话轮询无上限 | `conversation-detail.tsx:93-107` | 加最大轮询次数/退避 |
| `sr-only` 仅 14 处 | 全局 | 关键交互补无障碍文案 |
| workspace-client 单文件 2436 行 | `workspace-client.tsx` | 按面板拆分组件（纯重构，随 P1-4 一起做） |

---

## 五、实施路线图建议

| 阶段 | 内容 | 工作量 | 用户感知 |
|---|---|---|---|
| P0（8 项） | 上传统一/防误清/权限一致性/死路由/横滚+confirm/下载全部/触屏/死按钮 | 每项 0.5-2 天 | 明显减少日常挫败感 |
| P1（4 项） | 全局任务通知/资产库分页+批量/移动端三大工作区/进度+导出精简 | 每项 2-5 天 | 能力补齐，对标主流 SaaS |
| P2（5 项） | Cmd+K/toast 撤销/Temu 增强/onboarding/细节清理 | 每项 1-4 天 | 从"能用"到"好用"的质变 |

---

## 附录：已发现缺陷完整清单（按模块）

### 全局 / 导航
| 缺陷 | 位置 |
|---|---|
| /settings 死路由重定向到营销首页 | `src/app/(dashboard)/settings/page.tsx:8` |
| 顶栏标题缺 3 个新路由映射，回退"数据看板" | `src/components/sidebar/dashboard-header-title.tsx:19-45` |
| `(assets-fixed)` 路由组无 loading.tsx | `src/app/(assets-fixed)/` |
| 鼠标表情球默认开启 | `nav-user.tsx:82` |
| 个人设置入口仅藏在头像下拉二级弹窗 | `nav-user.tsx:232-240` |
| `top-16` 硬编码 ×4 | `create/page.tsx:52`、`chat/page.tsx:64`、`temu/page.tsx:114`、`workspace-client.tsx:1766` |
| 品牌图双 CDN 域名不一致 | `landing-page.tsx:12-15` vs `login-form.tsx:14` |

### 权限 / 错误处理
| 缺陷 | 位置 |
|---|---|
| /chat、/templates 抛原始 FORBIDDEN 英文错误 | `chat/page.tsx:29-31`、`templates/page.tsx:9-11` |
| 无权限三种处理方式并存 | 对比 `temu/page.tsx:79-83`（友好） |

### 创作流（/create）
| 缺陷 | 位置 |
|---|---|
| 上传无拖拽/无粘贴/串行/无进度/无取消 | `create-prompt-input.tsx:236-297` |
| 前端 10MB vs 服务端 20MB 上限不一致 | `create-prompt-input.tsx:38` vs `src/lib/upload/limits.ts:10` |
| 两套上传组件能力/白名单不一致 | `reference-image-upload.tsx:20` vs `create-prompt-input.tsx:250-262` |
| 切模型静默清空参考图 | `create-prompt-input.tsx:223-234` |
| 任务轮询绑页面，跨页无通知 | `create-prompt-input.tsx:376`、`use-task-polling.ts:32` |
| 结果只能逐张下载 | `task-detail-card.tsx:485-491` |
| hover-only 操作触屏不可达 | `task-detail-card.tsx:388-394, 486` |
| 无排队位置/ETA | `task-detail-card.tsx:522-533` |
| 会话轮询 4s 无上限 + 整页 refresh | `conversation-detail.tsx:93-107` |
| 失败占位格固定 1:1 | `task-detail-card.tsx:511-520` |
| 无单图收藏/单图删除（仅整批删） | `task-detail-card.tsx` |

### 资产库（/assets）
| 缺陷 | 位置 |
|---|---|
| 200 条硬上限，无服务端分页 | `src/app/(assets-fixed)/assets/page.tsx:11` |
| 无排序切换 | `image-gallery.tsx`（固定时间倒序） |
| 无多选/批量下载/删除/移动 | `image-gallery.tsx` 全文 |
| 卡片下载绕过统一下载器 | `image-gallery.tsx:308-315` |
| 搜索无防抖（大列表全量 filter+重分列） | `image-gallery.tsx:346-350` |

### 批量生图（/workspace）
| 缺陷 | 位置 |
|---|---|
| 2436 行单体组件 | `workspace-client.tsx` |
| 固定 280px 无响应式 | `workspace-client.tsx:103, 1769` |
| 4 路轮询对账 + 冷却防御代码（同步脆弱） | `workspace-client.tsx:107-108` |
| 导出弹窗 4 步 | `export-dialog.tsx:41` |
| 新建任务弹窗 2 步 | `new-task-dialog.tsx:41-42` |

### Temu 数据面板
| 缺陷 | 位置 |
|---|---|
| 12 列宽表无横向滚动 | `src/app/(dashboard)/temu/page.tsx:398-457` |
| 表格无列排序/无导出 | `products-table.tsx` 等 |
| loadMore 失败静默吞掉（空 catch） | `products-table.tsx:342-344` |
| 原生 confirm() ×2 + 手写弹层（无焦点陷阱） | `store-manager.tsx:54-74, 263-275` |
| 图表日期口径纯客户端 state 不进 URL | `overview-charts.tsx`（对比店铺切换是 URL 驱动） |
| hex 与 chart token 混用 | `products-table.tsx:248` |

### 样机（/mockup）
| 缺陷 | 位置 |
|---|---|
| 原生 confirm() ×1 | `mockup/batch-client.tsx:497` |
| 响应式类仅 3 处 | `mockup-client.tsx` |

### 登录 / 营销
| 缺陷 | 位置 |
|---|---|
| 注册/忘记密码/社交登录 5 个死按钮 | `login-form.tsx:74-84, 107-135` |

### UI 基础设施
| 缺陷 | 位置 |
|---|---|
| 12 文件残留硬编码 hex；`bg-black/white` 裸色 140 处；任意值约 280 处 | 全局（营销页属刻意可豁免） |
| 死依赖 `@tanstack/react-table` v9 | `package.json` |
| `empty.tsx` 组件仅 1 处使用 | `src/components/ui/empty.tsx` |
| `sr-only` 仅 14 处、快捷键仅 11 文件 | 全局 |
| 无 i18n（全量硬编码中文，`<html lang="zh-CN">`） | 如有出海需求需全量改造，暂可接受 |

---

*报告完。建议按 P0 → P1 → P2 顺序排期，P0 全部为局部改动，可在一两个迭代内完成。*
