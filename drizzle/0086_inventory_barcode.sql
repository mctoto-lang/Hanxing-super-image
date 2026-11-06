-- 商品档案条码字段（0086）：needsBarcode 布尔改为 barcode 文本
--   （出厂已贴填此栏，一般为单链接商品；空=未预贴，TEMU 发货单列表标
--   「需要打印条码」徽标，发货时一并打印）。生产单辅料「条码」默认勾选
--   逻辑同步改为「条码为空时默认勾」。
-- 无回填：原 needsBarcode=true（需打码）与「条码为空=未预贴」语义天然对齐。
ALTER TABLE "inventory_product" ADD COLUMN IF NOT EXISTS "barcode" varchar(64);
--> statement-breakpoint
ALTER TABLE "inventory_product" DROP COLUMN IF EXISTS "needs_barcode";
