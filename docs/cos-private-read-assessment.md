# COS 桶「公有读 → 私有读」影响评估与可选路线

> 2026-11-19 评估稿（仅分析，未动代码/未改桶）。决策后按第四节分阶段实施。
> 背景：写侧一直是私有（密钥写入），本文「私有读写」实际变化点只有**读**。

## 结论先行

1. 当前架构**以「公有读私有写」为前提设计**：展示层浏览器直连 COS 公网 URL，数据库全部存**未签名 canonical URL**（`https://{bucket}.cos.{region}.myqcloud.com/{key}`）。
2. **直接把桶切成私有读 = 全站裂图 + AI 参考图/发品回拉/下载导出全断**，没有任何一条展示链路自带签名。
3. 签名能力已具备一半：`presignGet`（`src/lib/storage/cos.ts:345`，默认 600s）已实现，但目前**全仓只有 AI vision 带图一处**（`src/server/services/ai-json.ts:21`）在用。
4. 可选路线三条（第三节）：**A 维持公有读**（现口径）/ **B 私有读 + 全链路签名改造**（约 15 个触点，工作量大）/ **C 桶策略按前缀折中**（应用零改动）。

## 一、现状（公有读私有写）

| 环节 | 实现 | 位置 |
|---|---|---|
| 上传落 URL | `saveFromBuffer`/`presignPut` 返回**未签名** canonical URL 直接入库 | `src/lib/storage/cos.ts:220,313` |
| 展示 | `toImageSrc` 命中 `.myqcloud.com` 原样返回（可拼 imageMogr2 缩略参）；SmartImage / ImageViewer / ZoomableImage 裸 `<img src>` | `src/lib/utils.ts:17-42`、`src/components/ui/smart-image.tsx:83` |
| TEMU 主图 | `temuImageSrc`：`mainImageCosUrl` → COS 直连，回落 kwcdn | `src/lib/temu/image.ts:14` |
| 下载 | 客户端统一走 `/api/image/proxy`（代理回源是**未签名 GET**） | `src/lib/storage/proxy.ts:7`、`src/app/api/image/proxy/route.ts:250` |
| 权限边界 | **UUID key 不可猜 + 代理层租户校验**（`docs/storage-lifecycle.md:51` 明文口径） | — |

DB 存 COS URL 的列（全部裸 URL）：`generation_task.result_images/reference_images`（gen/、ref/ 30 天过期）、`temu_products.main_image_cos_url`（temu/ 永久）、发品模板素材、`inventory_product.image_url`（inventory/ 永久）、头像/模型图标/企业 logo（config/ 永久）、样机资产、工作台出卡图。

## 二、切换私有读后的逐项变化

### A. 浏览器直连（全部 403 裂图）
- 生成结果/资产页/TEMU 表格缩略/库存档案图/头像/logo：经 `toImageSrc`/SmartImage/ZoomableImage 全部显示「图片已过期」占位——**403 与真过期表象不可区分**（SmartImage 降级链无法分辨）。
- 登录页品牌图：`src/components/login-form.tsx:13` 硬编码 COS URL，**未登录页直连**；`/api/image/proxy` 要求登录（route.ts:193），无现成通路。

### B. 服务端消费（403 或静默降级）
| 消费方 | 位置 | 后果 |
|---|---|---|
| AI 图生图参考图出站（上游拉取） | `src/lib/ai/index.ts:76` | **上游拉不到参考图，图生图全废**（影响最大） |
| Gemini 对话取图 | `src/lib/ai/chat/gemini-chat.ts:129` | 单图失败被跳过 → 静默丢图 |
| 图片代理回源（下载/放大） | `src/app/api/image/proxy/route.ts:250` | 下载全 403 |
| 样机素材中转 | `src/server/services/mockup-service.ts:176-198` | 双路径（外部拉取/自 fetch）均断 |
| 工作台导出 ZIP | `src/app/api/workspace/export/route.ts:157` | 导出包缺图 |
| TEMU 发品回拉（素材/轮播/PDF） | `src/server/actions/temu-publish.ts:558,604,685,960` | 发品取回字节失败 |
| 存储探测 | `src/server/services/status-service.ts:410` | HEAD 403（现逻辑视为在线，需复核语义） |
| 回填脚本 | `scripts/backfill-result-image-sizes.ts` | imageInfo 探测全 miss |
| AI vision 带图 | `src/server/services/ai-json.ts:21`（presignGet） | ✅ 唯一不受影响 |

### C. 其它注意点
- **签名与缩略参互斥**：COS XML 签名覆盖 query；`toImageSrc` 的 `?imageMogr2/thumbnail/Nx` 是签名后追加 → 会破坏签名。签名时必须把处理参数一并签进去。
- 内网端点改写（`cosForceInternalEndpoint`）同样受桶读 ACL 约束，内网未签名 GET 一样 403。
- SmartImage 的 immutable 长缓存与签名 URL 的短有效期（600s）策略冲突，需统一改为短缓存或走代理。
- **DB 存量 URL 无需刷库**（签名是渲染期临时叠加），但要保证每条展示路径都过签名/代理。

## 三、可选路线对比

| 路线 | 改动 | 安全性变化 | 代价 |
|---|---|---|---|
| **A. 维持公有读**（现口径） | 零 | 依赖 key 不可猜（UUID）+ 代理层租户校验；拿到确切 URL 的任何人可读（30 天后 gen/ref 本就被生命周期删除） | 无；接受「URL 即凭证」 |
| **B. 私有读 + 全链路签名** | ~15 触点分阶段（见第四节） | 只有持签名/登录态者可读，URL 泄露无法直接访问 | 工作量大；签名过期/缓存策略需重设计；图片流量若改走代理则应用服务器带宽成为瓶颈 |
| **C. 桶策略按前缀折中** | 应用零改动，仅桶策略 | 长期资产（config/temu/inventory）保持可读，gen/ref 等短生命周期前缀 Deny 匿名读 | 保护面不完整；策略规则需随前缀演进维护；展示层 gen/ 图同样需要签名或代理 → 实际还是要做 B 的一部分 |

**倾向**：当前「UUID key + 生命周期删除 + 代理租户校验」已覆盖主要风险面（30 天自动删、TEMU/库存图本质是公开商品图）；若确有合规/客户要求再启动 B。

## 四、若选 B：分阶段改造清单

1. **展示层**（最大头）：`toImageSrc` 换签名 URL（服务端渲染期 presignGet，需支持带 imageMogr2 参数签名+更长有效期）或统一改走 `/api/image/proxy` 签名回源；SmartImage 缓存策略与降级链适配；各 action 返回 URL 处集中过一层签名工具。
2. **登录页品牌图**：改公开 CDN / dataURL 内联 / 新增免鉴权品牌图路由（三选一）。
3. **AI 出站**：`ai/index.ts:76` 参考图改发 presignGet 结果（与 ai-json.ts 同法）；`gemini-chat.ts` 取图改签名。
4. **服务端 fetch 统一签名**：image/proxy、mockup-service、workspace/export、temu-publish 四处 + probeStorage/backfill 脚本的 403 语义区分。
5. **验收**：全站图片（生成/TEMU/库存/头像/logo/登录页）+ 图生图 + 下载 + 导出 + 发品 + 打印链路回归；私有读桶上跑全量集成测试。

## 附录：切换域名设置清单（2026-11-19）

生产 `.env` 改两项后 `docker compose up -d` 重启即可，**无需 rebuild**（`.dockerignore` 排除 `.env*`；`NEXT_PUBLIC_APP_URL` 仅服务端经 `src/lib/env.ts` 读取，不构建期内联）：

1. `NEXT_PUBLIC_APP_URL=https://你的域名`（图片 URL 生成与 /uploads 同源校验基准）
2. `AUTH_URL=https://你的域名`（必设：不设会解析出两套互斥 cookie、登录重定向错地址）
3. 前置：DNS 解析 + 1Panel/OpenResty 反代 443→`APP_PORT`(3000) + HTTPS 证书；国内服务器域名须 ICP 备案
4. 无需改动：`next.config.ts`（无 images/assetPrefix/CORS）、Auth.js 配置（`AUTH_TRUST_HOST=true` 已有）、下载白名单（全部由 `NEXT_PUBLIC_APP_URL` 推导，自动适配）、`allowedDevOrigins`（仅 dev 生效）
