"use client";

/**
 * 「立即订阅」小票打印机弹窗（pricing-section 接线）。
 *
 * 项目不接入在线支付：点击订阅改为弹出 ReceiptPrinter 打印一张订阅小票，
 * 原条形码位置换成**占位二维码**（确定性伪随机模块 + 三个定位角，不可扫描，
 * 后续接入真实客服码时替换 QrSlot 内的 SVG 即可），引导扫码联系平台客服
 * 充值订阅激活。配色沿用营销页深色口径（neutral-950 + white/xx）。
 */

import { useEffect, useMemo, useState } from "react";
import ReceiptPrinter, {
  type ReceiptItem,
} from "@/components/ui/kokonut-receipt-printer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/datetime";
import type { Frequency, Plan } from "./pricing-section";

/** 与 footer / 顶栏一致的站名口径 */
const SITE_NAME = "StarChart 瀚星星图";

const ORDER_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 8 字符伪订单号（32 字符集 ≈ 1e12 组合）：纯前端无持久化，作客服对账
 *  编号需降低碰撞概率（4 字符仅 ~105 万组合） */
function genOrder() {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += ORDER_CHARS[Math.floor(Math.random() * ORDER_CHARS.length)];
  }
  return `SC-${s}`;
}

/* ---------------- 占位二维码：seed 哈希 → PRNG 的确定性图案 ---------------- */

const QR_SIZE = 21;
/** zinc-800，与小票油墨同色 */
const QR_INK = "#27272a";

function hashSeed(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 定位角（左上/右上/左下 7×7 回字纹），与真二维码一致的视觉锚点 */
function QrFinder({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect fill={QR_INK} height={7} width={7} x={x} y={y} />
      <rect fill="#fff" height={5} width={5} x={x + 1} y={y + 1} />
      <rect fill={QR_INK} height={3} width={3} x={x + 2} y={y + 2} />
    </g>
  );
}

function QrPlaceholder({ seed, className }: { seed: string; className?: string }) {
  const cells = useMemo(() => {
    const rand = mulberry32(hashSeed(seed));
    const inFinder = (x: number, y: number) =>
      (x < 7 && y < 7) ||
      (x >= QR_SIZE - 7 && y < 7) ||
      (x < 7 && y >= QR_SIZE - 7);
    const out: { x: number; y: number }[] = [];
    for (let y = 0; y < QR_SIZE; y++) {
      for (let x = 0; x < QR_SIZE; x++) {
        if (!inFinder(x, y) && rand() < 0.45) {
          out.push({ x, y });
        }
      }
    }
    return out;
  }, [seed]);
  return (
    <svg
      aria-hidden="true"
      className={className}
      shapeRendering="crispEdges"
      viewBox={`0 0 ${QR_SIZE} ${QR_SIZE}`}
    >
      {cells.map((c) => (
        <rect
          fill={QR_INK}
          height={1}
          key={`m-${c.x.toString()}-${c.y.toString()}`}
          width={1}
          x={c.x}
          y={c.y}
        />
      ))}
      <QrFinder x={0} y={0} />
      <QrFinder x={QR_SIZE - 7} y={0} />
      <QrFinder x={0} y={QR_SIZE - 7} />
    </svg>
  );
}

/** 小票原条形码位置的替换内容：二维码占位 + 客服引导文案 */
function QrSlot({ order }: { order: string }) {
  return (
    <div className="mt-3 flex flex-col items-center">
      <QrPlaceholder className="h-20 w-20" seed={order} />
      <p className="mt-1.5 text-center">扫码联系平台客服</p>
      <p className="text-center text-zinc-500">充值订阅 · 激活服务</p>
    </div>
  );
}

/* --------------------------------- 弹窗 --------------------------------- */

interface SubscribeReceiptDialogProps {
  plan: Plan | null;
  frequency: Frequency;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SubscribeReceiptDialog({
  plan,
  frequency,
  open,
  onOpenChange,
}: SubscribeReceiptDialogProps) {
  // 惰性初始化订单号：首帧即有值（effect 在 paint 后才 set，首帧会闪空订单号
  // 与 seed="" 的固定二维码图案）；组件仅在客户端 plan 非空时渲染内容，无 hydration 风险
  const [order, setOrder] = useState(() => genOrder());
  useEffect(() => {
    if (open) {
      // 每次打开重新生成订单号（二维码图案随订单号变化）
      setOrder(genOrder());
    }
  }, [open]);

  if (!plan) {
    return null;
  }

  // 套餐行 + 权益行（quantity 0：免费权益，小票上显 0.00；名称优先用 receipt 短标签保证单行）
  const items: ReceiptItem[] = [
    {
      name: `${plan.name} · ${frequency === "monthly" ? "月付" : "年付"}`,
      quantity: 1,
      price: plan.price[frequency],
    },
    ...plan.features.map((feature) => ({
      name: feature.receipt ?? feature.text,
      quantity: 0,
      price: 0,
    })),
  ];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-3 bg-neutral-950 p-4 text-white ring-white/15 sm:max-w-[21rem]">
        <DialogHeader>
          <DialogTitle className="pr-8 text-white">
            订阅 · {plan.name}
          </DialogTitle>
          <DialogDescription className="text-left text-white/60">
            平台暂未接入在线支付——小票打印完成后，扫描二维码联系平台客服，充值后即可激活订阅。
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-center">
          <ReceiptPrinter
            className="h-[31rem] sm:h-[32rem]"
            code={<QrSlot order={order} />}
            currency="¥"
            date={formatDateTime(new Date())}
            footerText="感谢订阅 · 充值后激活"
            items={items}
            merchant={SITE_NAME}
            order={order}
            tax={0}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
