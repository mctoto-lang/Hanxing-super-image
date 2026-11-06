/**
 * TEMU 各表表头统一口径（对齐库存 DataTable 的 th：sticky top-0 z-10 h-11 bg-muted px-3）。
 * 含列间竖线，对齐库存 DataTable columnDividers 口径（th 与 td 同加线）。
 * 字号随表体（TEMU 密表 text-xs，不跟随库存的 text-sm）；
 * [&_th] 变体挂在 thead 上，只作用于表头行，不会波及 tbody 内嵌套子表的紧凑 th。
 */
export const TEMU_TABLE_HEADER_CLASS =
  "sticky top-0 z-10 bg-muted [&_th]:h-11 [&_th]:px-3 [&_th:not(:first-child)]:border-l [&_th:not(:first-child)]:border-border"
