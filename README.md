# 瀚星 Super Image

企业级 AI 图片工作台 · 多租户 SaaS · Docker Compose 自托管

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Next.js 16（App Router · Server Components · Server Actions） |
| 语言 | TypeScript（strict） |
| 数据库 | PostgreSQL 16 + Drizzle ORM |
| 缓存/队列 | Redis 7 + ioredis |
| 认证 | Auth.js v5（Credentials） |
| UI | shadcn/ui（Base UI）+ Tailwind CSS v4 · 暗色模式 |
| 包管理 | pnpm 11 |
| 部署 | Docker Compose（多阶段构建 · standalone 输出） |

## 快速开始（开发）

### 1. 环境准备

- Node.js ≥ 22
- pnpm ≥ 11
- PostgreSQL 16 + Redis 7（可用 Docker 一键启动）

```bash
# 启动开发期 PG + Redis
docker compose -f docker-compose.dev.yml up -d
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少修改 AUTH_SECRET 和 ENCRYPTION_KEY
```

### 4. 数据库迁移 + 种子

```bash
pnpm db:generate    # 生成迁移文件
pnpm db:migrate     # 执行迁移
pnpm db:seed        # 种子超管账号
```

### 5. 启动开发服务器

```bash
pnpm dev
```

打开 http://localhost:3000，使用种子超管账号登录（默认 `superadmin`，密码见控制台输出）。

## 生产部署（Docker Compose）

### 1. 准备环境变量

```bash
cp .env.example .env
```

**必须修改的项：**

| 变量 | 说明 |
|---|---|
| `AUTH_SECRET` | 至少 32 字符随机串，`openssl rand -hex 32` |
| `ENCRYPTION_KEY` | 至少 32 字符，用于 API Key 加密落库 |
| `POSTGRES_PASSWORD` | 数据库密码 |
| `SUPERADMIN_PASSWORD` | 超管初始密码（留空则随机生成） |

### 2. 构建并启动

```bash
docker compose up -d --build
```

### 3. 执行数据库迁移

```bash
docker compose run --rm migrate
```

### 4. 验证

```bash
# 健康检查
curl http://localhost:3000/api/health
# 预期返回 {"status":"healthy","checks":{"postgres":"ok","redis":"ok"}}
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | PostgreSQL 连接串 |
| `REDIS_URL` | 是 | Redis 连接串 |
| `AUTH_SECRET` | 是 | Auth.js 密钥（≥ 32 字符） |
| `ENCRYPTION_KEY` | 是 | AES-256-GCM 加密密钥（≥ 32 字符） |
| `SUPERADMIN_USERNAME` | 否 | 超管用户名（默认 `superadmin`） |
| `SUPERADMIN_PASSWORD` | 否 | 超管密码（留空随机生成） |
| `NEXT_PUBLIC_APP_URL` | 否 | 应用 URL（默认 `http://localhost:3000`） |
| `COS_SECRET_ID` | 否 | 腾讯云 COS（配置后启用对象存储） |
| `COS_SECRET_KEY` | 否 | 同上 |
| `COS_BUCKET` | 否 | 同上 |
| `COS_REGION` | 否 | 同上 |
| `COS_BASE_URL` | 否 | 同上 |
| `CRON_SECRET` | 否 | `/api/cron/*` 的 Bearer token |
| `QUEUE_POLL_INTERVAL_MS` | 否 | 队列轮询间隔（默认 2000ms） |

## 项目结构

```
src/
├── app/                        # App Router
│   ├── (dashboard)/            # 业务页面（创作/资产/批量/商品）
│   ├── (admin)/admin/          # 企业管理（成员/模型/权限组/积分/日志）
│   ├── (superadmin)/platform/  # 平台管理（企业/用户/系统设置）
│   ├── (auth)/                 # 登录页
│   └── api/                    # Route Handlers
├── components/                 # UI 组件（shadcn/ui + 业务组件）
├── db/
│   ├── schema/                 # Drizzle schema（按域拆分）
│   └── client.ts               # Drizzle 客户端单例
├── lib/                        # 核心库（auth/crypto/redis/storage/env）
├── server/
│   ├── actions/                # Server Actions
│   ├── services/               # 业务服务层
│   └── schemas/                # Zod 校验 schema
└── ...
```

## 常用命令

```bash
pnpm dev              # 开发服务器
pnpm build            # 生产构建
pnpm start            # 生产启动
pnpm typecheck        # 类型检查
pnpm lint             # ESLint
pnpm test             # 单元测试
pnpm db:generate      # 生成迁移
pnpm db:migrate       # 执行迁移
pnpm db:studio        # Drizzle Studio（数据库 GUI）
pnpm db:seed          # 种子数据
```

## 多租户架构

- **行级隔离**：所有业务表带 `enterprise_id`，查询强制注入 WHERE 条件
- **角色**：超管（全局）→ 企业主/管理员（本企业）→ 成员（仅自己数据）
- **积分**：企业级共享积分池，全员共享扣减
- **模块开关**：超管为企业配置 `enabled_modules`，成员只能访问已开通模块

## 许可

私有项目，未授权不可使用。
