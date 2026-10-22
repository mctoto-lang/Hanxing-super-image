-- TEMU 店铺 mallId 拓宽：bg.open.accesstoken.info.get.global 返回的 uniqueId
-- 实测为 base64 串（约 56 字符，如 eyJ1IjoidXVPUUlm...），varchar(32) 会截断；
-- 拓宽到 64 容纳完整标识（幂等，已存在的截断值重录 token 验证时会自动修正）。
ALTER TABLE "temu_store" ALTER COLUMN "mall_id" TYPE varchar(64);
