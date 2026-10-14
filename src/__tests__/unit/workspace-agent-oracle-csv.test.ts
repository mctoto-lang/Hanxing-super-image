import { describe, expect, it } from "vitest"
import {
  ORACLE58_CARDS,
  ORACLE_COPY_CSV_COLUMNS,
  oracleCopyRowsToCsv,
  type OracleCopyCsvEntry,
} from "@/lib/workspace/agent-templates"

describe("神谕文案 CSV 交付物（oracleCopyRowsToCsv）", () => {
  const entryOf = (index: number, headline = "POISON", message = "The toxicity you ignore is the dose."): OracleCopyCsvEntry => {
    const card = ORACLE58_CARDS[index]!
    const separator = card.name.indexOf("·")
    return {
      index: card.index,
      groupName: separator > 0 ? card.name.slice(0, separator).trim() : card.name,
      headline,
      message,
    }
  }

  it("列头为 序号/分组/英文标题/英文正文", () => {
    const csv = oracleCopyRowsToCsv([])
    expect(csv).toBe(ORACLE_COPY_CSV_COLUMNS.join(","))
    expect(csv).toBe("序号,分组,英文标题,英文正文")
  })

  it("55 张位置牌全量导出：1 行列头 + 55 行数据，序号与骨架 index 对齐", () => {
    // 交付物只含 55 张位置牌（kind='position'），不含牌背/牌盒/边框
    const faceCards = ORACLE58_CARDS.filter((card) => card.kind === "position")
    expect(faceCards).toHaveLength(55)
    const entries = faceCards.map((card) => entryOf(card.index))
    const csv = oracleCopyRowsToCsv(entries)
    const lines = csv.split("\n")
    expect(lines).toHaveLength(1 + 55)
    expect(lines[1]).toContain("0,")
    expect(lines[55]).toContain("54,")
    // 首行数据：index 0 + 组名 + 标题 + 正文
    expect(lines[1]!.startsWith("0,组一,POISON,The toxicity")).toBe(true)
  })

  it("含逗号/引号/换行的正文按 RFC 4180 转义（整体加引号、内部引号翻倍）", () => {
    const csv = oracleCopyRowsToCsv([
      {
        index: 0,
        groupName: "组一",
        headline: "DOUBT",
        message: 'You asked, "is it me?"\nand the mirror said yes',
      },
    ])
    const lines = csv.split("\n")
    // 正文含换行 → 该行整体被引号包裹，CSV 行数比条目数多（引号内换行保留）
    expect(lines.length).toBeGreaterThan(2)
    expect(csv).toContain('"You asked, ""is it me?""')
    expect(csv).toContain("and the mirror said yes")
  })

  it("空标题/正文按空串导出，不产生 undefined/null", () => {
    const csv = oracleCopyRowsToCsv([
      { index: 7, groupName: "组一", headline: "", message: "" },
    ])
    expect(csv.split("\n")[1]).toBe("7,组一,,")
    expect(csv).not.toContain("undefined")
    expect(csv).not.toContain("null")
  })

  it("多条目行间以 \\n 分隔且结尾不带换行", () => {
    const csv = oracleCopyRowsToCsv([
      entryOf(0, "EMBER", "Warmth remains where the fire used to be."),
      entryOf(1, "THRESHOLD", "One step more and the old room forgets you."),
    ])
    expect(csv.endsWith("\n")).toBe(false)
    const lines = csv.split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("EMBER")
    expect(lines[2]).toContain("THRESHOLD")
  })
})
