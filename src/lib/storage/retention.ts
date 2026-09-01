/**
 * 图片保留策略（固定值，不可配置）。
 *
 * 纯常量叶子模块：无任何依赖，客户端组件可直接导入（storage/config.ts
 * 链接数据库客户端，不能进客户端 bundle）。
 *
 * 对象删除主路径：腾讯云 COS 生命周期规则（按 ref/、gen/ 前缀自动删除）。
 * 应用 cleanup cron 按此常量做备份清理（本地模式主路径，COS 模式兜底），
 * 二者任一生效即可、幂等无害。config 类（logo/图标/模板图）永不过期。
 *
 * ⚠️ 修改保留期必须两处同步：本常量 + COS 控制台生命周期规则
 * （见 docs/storage-lifecycle.md）。
 */
export interface ImageRetentionConfig {
  /** 参考图保留天数（generationTasks.referenceImages） */
  referenceRetainDays: number
  /** 生成图保留天数（resultImages + conversations.lastImageThumb） */
  generateRetainDays: number
}

export const IMAGE_RETENTION: ImageRetentionConfig = {
  referenceRetainDays: 30,
  generateRetainDays: 30,
}
