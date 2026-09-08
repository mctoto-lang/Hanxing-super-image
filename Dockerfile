# ─── Stage 1: deps ──────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

WORKDIR /app

# 仅复制 manifest（含 workspace 文件——pnpm 11 依赖它读取
# onlyBuiltDependencies 许可，缺它 sharp 等原生依赖构建会被跳过），利用 Docker 层缓存
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile


# ─── Stage 2: builder ───────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 构建时需要的环境变量（Next.js 公共变量）
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# 迁移产物由开发机 `pnpm db:generate` 生成并随代码提交（.dockerignore
# 不排除 drizzle/meta），此处直接使用——镜像内绝不能再 generate（无
# snapshot 会从零生成全新初始迁移，导致 migrate 服务执行漂移的迁移链）
RUN pnpm build


# ─── Stage 3: runner ────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 创建非 root 用户
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# 复制 standalone 产物（含最小 node_modules）
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# 复制 drizzle 迁移文件（迁移由 migrate 服务执行：
# docker compose run --rm migrate；runner 镜像无 drizzle-kit/源码）
COPY --from=builder /app/drizzle ./drizzle

# 创建上传目录并赋权
RUN mkdir -p /app/uploads && chown nextjs:nodejs /app/uploads

# 复制启动脚本
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
