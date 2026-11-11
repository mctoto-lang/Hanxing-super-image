-- 0096：ship_deduct 流水幂等唯一索引兜底
--   库存「TEMU发货单同步」人工一键补扣入口（syncTemuShipDeductAction）可并发重复提交
--   同一发货单（双开标签页/两用户同时点「同步扣减」），幂等查重在事务外存在
--   「两次查重都通过→先后写两条流水→库存双扣」窗口。代码侧已把查重移入扣减事务
--   并按单号取事务级咨询锁（pg_advisory_xact_lock）串行化；本索引为数据库级兜底。
--   键含 product_id：一张发货单可含多个货号（多条流水同 refId 合法）；
--   部分唯一索引仅约束 type='ship_deduct' AND ref_type='ship_order'——
--   生产单分批入库（production_in×同单多次）、直发一单多次（factory_direct）等
--   同 refId 多条流水的合法场景不受影响。
CREATE UNIQUE INDEX IF NOT EXISTS inv_mv_ship_deduct_uq
  ON inventory_movement (enterprise_id, ref_id, product_id)
  WHERE type = 'ship_deduct' AND ref_type = 'ship_order';
