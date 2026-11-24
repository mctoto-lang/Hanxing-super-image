import { PageLoading } from "@/components/shared/page-loading"

/**
 * 选品工具各页的路由级加载态：服务端取数（数据池 / 监控列表 / 评论统计）期间
 * 显示统一加载符，替代整页空白。
 */
export default function SelectionLoading() {
  return <PageLoading label="加载选品数据…" />
}
