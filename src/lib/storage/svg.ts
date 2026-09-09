/**
 * SVG 图标内容清洗（纵深防御层，非唯一防线）
 *
 * 模型图标支持 SVG 上传后的三层防护之一：
 * 1. 本模块：上传时剥离脚本类标记/属性（strip script、on* 事件、
 *    javascript:/data:text/html 引用、foreignObject、DOCTYPE/ENTITY）；
 * 2. 存储/托管层：所有 SVG 以 Content-Disposition: attachment 服务——
 *    直接导航变下载而非执行，封死存储型 XSS 主向量（<img> 渲染不受影响）；
 * 3. 渲染层：图标一律经 <img> 标签展示（img 中的 SVG 不执行脚本）。
 */

/** 剥离成对出现的危险块（script / foreignObject，含自闭合与大小写变体） */
function stripBlocks(source: string, tag: string): string {
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}\\s*>`, "gi")
  // 自闭合形式 <script ... /> 不合法但宽容处理
  const selfClosing = new RegExp(`<${tag}[^>]*\\/\\/>`, "gi")
  return source.replace(re, "").replace(selfClosing, "")
}

/** 剥离内联事件属性：onclick="..." / onerror='...' / onload=xxx */
function stripEventAttrs(source: string): string {
  return source.replace(
    /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    "",
  )
}

/** 剥离脚本类 URL 引用：href/xlink:href 指向 javascript: 或 data:text/html */
function stripScriptUrls(source: string): string {
  return source.replace(
    /(\s(?:href|xlink:href)\s*=\s*)(?:"\s*(?:javascript|vbscript|data:text\/html)[^"]*"|'\s*(?:javascript|vbscript|data:text\/html)[^']*'|(?:javascript|vbscript|data:text\/html)[^\s>]*)/gi,
    '$1""',
  )
}

/** 剥离 DOCTYPE 与 ENTITY 声明（XXE / billion-laughs 类向量） */
function stripDoctype(source: string): string {
  return source
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "")
}

/** 清洗 SVG 源文本；非字符串/空值原样返回（调用方再按无效内容拒绝） */
export function sanitizeSvg(source: string): string {
  if (!source) return source
  let out = source
  out = stripDoctype(out)
  out = stripBlocks(out, "script")
  out = stripBlocks(out, "foreignObject")
  out = stripEventAttrs(out)
  out = stripScriptUrls(out)
  return out
}
