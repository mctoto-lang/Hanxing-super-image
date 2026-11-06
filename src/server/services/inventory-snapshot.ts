import { sql } from "drizzle-orm"
import { db } from "@/db/client"

/**
 * 库存日快照（批次5）：worker 每小时检查，当日快照不存在则插入、存在则更新
 * （当天快照始终≈当前量，次日自然冻结）。趋势/收发存期初/缺货统计的底座。
 */

/** 落当日全量快照（所有企业：有库存明细的 货号×仓），返回落库行数
 *  JOIN enterprises 只快照仍存在的企业（防与并发删除竞态炸 FK） */
export async function runDailyInventorySnapshots(): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO inventory_snapshot (enterprise_id, day, product_id, warehouse_id, qty)
    SELECT s.enterprise_id, (now() at time zone 'Asia/Shanghai')::date, s.product_id, s.warehouse_id, s.qty
    FROM inventory_stock s
    JOIN enterprise e ON e.id = s.enterprise_id
    ON CONFLICT (day, product_id, warehouse_id)
    DO UPDATE SET qty = EXCLUDED.qty
  `)
  return r.count ?? 0
}
