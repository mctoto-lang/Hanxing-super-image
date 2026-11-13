import { FlaskConical } from "lucide-react"

/**
 * TEMU 演示模式提示条（企业未配置任何 TEMU 应用时展示于 tab 行下方）：
 * 内置虚拟演示数据（100 款商品、售价 100+ 元、单日销量 100+），可浏览可
 * 操作，均不影响真实店铺。
 */
export function TemuDemoBanner() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5 text-sm text-amber-700 dark:text-amber-400">
      <FlaskConical className="mt-0.5 size-4 shrink-0" />
      <p>
        <b>演示模式</b>：当前企业尚未配置 TEMU 应用，展示的是<b>内置虚拟演示数据</b>
        （100 款商品，售价与销量为演示口径），可浏览、可操作，均不影响真实店铺。
        配置 TEMU 应用后将自动切换为正式数据。
      </p>
    </div>
  )
}
