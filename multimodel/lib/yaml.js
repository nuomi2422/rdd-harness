'use strict';
/**
 * yaml.js —— 只支持「测试卡需要的那一小撮 YAML」的严格解析器
 *
 * 为什么不 npm install js-yaml：
 *   1) 本 harness 的既有约定是零依赖（app/server.js 头注释写了原因）；
 *   2) 测试卡是**外部可提交**的输入，YAML 的锚点/别名/标签/合并键正是
 *      路径穿越和算法复杂度攻击的常见入口。与其解析完再拦，不如根本不支持。
 *
 * 支持：
 *   - 块状 mapping（缩进用空格）
 *   - 块状 sequence（`- `，支持标量项和 mapping 项）
 *   - flow sequence `[a, b]` / flow mapping `{a: 1, b: "x"}`
 *   - 单/双引号字符串、整数、小数、true/false/null
 *   - `#` 注释（引号内的不算）
 *
 * 明确拒绝（抛 YamlError，带行号）：
 *   - tab 缩进、重复键、锚点 `&` / 别名 `*` / 标签 `!` / 合并键 `<<`
 *   - 文档分隔符 `---` / `...`、多文档、块标量 `|` `>`
 *   - 缩进跳级、值后面又跟更深缩进
 *   - 超过 maxBytes 或 maxDepth
 */

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message}（第 ${line} 行）` : message);
    this.name = 'YamlError';
    this.line = line || 0;
  }
}

const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 24;

function stripComment(line) {
  let inS = false, inD = false, esc = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inD) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inD = false;
      continue;
    }
    if (inS) {
      if (c === "'") {
        if (line[i + 1] === "'") i++;
        else inS = false;
      }
      continue;
    }
    if (c === '"') { inD = true; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function parseScalar(text, line, depth) {
  const s = text.trim();
  if (!s) throw new YamlError('空标量', line);
  if (s[0] === '&' || s[0] === '*') throw new YamlError('不支持锚点/别名（& / *）', line);
  if (s[0] === '!') throw new YamlError('不支持 YAML 标签（!）', line);
  if (s === '|' || s === '>' || s.startsWith('|') || s.startsWith('>')) throw new YamlError('不支持块标量（| / >）', line);
  if (s[0] === '[' || s[0] === '{') {
    const r = parseFlow(s, 0, line, depth + 1);
    const rest = s.slice(r.pos).trim();
    if (rest) throw new YamlError(`flow 值后面还有多余字符：${rest}`, line);
    return r.value;
  }
  if (s[0] === '"') {
    let v;
    try { v = JSON.parse(s); } catch { throw new YamlError('双引号字符串不是合法 JSON 字面量', line); }
    return v;
  }
  if (s[0] === "'") {
    if (s.length < 2 || s[s.length - 1] !== "'") throw new YamlError('单引号字符串没有闭合', line);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (s === 'null' || s === 'Null' || s === 'NULL' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if (/^\.\d+$/.test(s)) return parseFloat('0' + s);
  return s;
}

function isMapLine(text) {
  return topLevelColon(text) >= 0;
}

function topLevelColon(text) {
  let inS = false, inD = false, esc = false, depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inD) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inD = false;
      continue;
    }
    if (inS) {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else inS = false;
      }
      continue;
    }
    if (c === '"') { inD = true; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0) {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

function parseFlow(str, start, line, depth) {
  if (depth > MAX_DEPTH) throw new YamlError('嵌套过深', line);
  let i = start;
  const ws = () => { while (i < str.length && /\s/.test(str[i])) i++; };
  ws();
  if (str[i] === '[') {
    i++;
    const arr = [];
    ws();
    if (str[i] === ']') { i++; return { value: arr, pos: i }; }
    for (;;) {
      const r = parseFlowValue(str, i, line, depth + 1);
      arr.push(r.value);
      i = r.pos;
      ws();
      if (str[i] === ',') { i++; ws(); continue; }
      if (str[i] === ']') { i++; return { value: arr, pos: i }; }
      throw new YamlError('flow sequence 缺少 , 或 ]', line);
    }
  }
  if (str[i] === '{') {
    i++;
    const obj = {};
    ws();
    if (str[i] === '}') { i++; return { value: obj, pos: i }; }
    for (;;) {
      ws();
      const k = parseFlowKey(str, i, line);
      i = k.pos;
      ws();
      if (str[i] !== ':') throw new YamlError('flow mapping 缺少 :', line);
      i++;
      const r = parseFlowValue(str, i, line, depth + 1);
      if (Object.prototype.hasOwnProperty.call(obj, k.value)) throw new YamlError(`重复键 ${k.value}`, line);
      obj[k.value] = r.value;
      i = r.pos;
      ws();
      if (str[i] === ',') { i++; ws(); continue; }
      if (str[i] === '}') { i++; return { value: obj, pos: i }; }
      throw new YamlError('flow mapping 缺少 , 或 }', line);
    }
  }
  throw new YamlError('flow 值必须以 [ 或 { 开头', line);
}

function parseFlowValue(str, start, line, depth) {
  let i = start;
  while (i < str.length && /\s/.test(str[i])) i++;
  if (str[i] === '[' || str[i] === '{') return parseFlow(str, i, line, depth);
  if (str[i] === '"') {
    let j = i + 1, esc = false;
    for (; j < str.length; j++) {
      if (esc) { esc = false; continue; }
      if (str[j] === '\\') { esc = true; continue; }
      if (str[j] === '"') break;
    }
    if (j >= str.length) throw new YamlError('flow 双引号字符串没有闭合', line);
    return { value: JSON.parse(str.slice(i, j + 1)), pos: j + 1 };
  }
  if (str[i] === "'") {
    let j = i + 1, val = '';
    for (; j < str.length; j++) {
      if (str[j] === "'") {
        if (str[j + 1] === "'") { val += "'"; j++; continue; }
        return { value: val, pos: j + 1 };
      }
      val += str[j];
    }
    throw new YamlError('flow 单引号字符串没有闭合', line);
  }
  let j = i;
  while (j < str.length && !/[,\]}]/.test(str[j])) j++;
  return { value: parseScalar(str.slice(i, j), line, depth), pos: j };
}

function parseFlowKey(str, start, line) {
  let i = start;
  if (str[i] === '"') {
    let j = i + 1, esc = false;
    for (; j < str.length; j++) {
      if (esc) { esc = false; continue; }
      if (str[j] === '\\') { esc = true; continue; }
      if (str[j] === '"') break;
    }
    if (j >= str.length) throw new YamlError('flow key 双引号没有闭合', line);
    return { value: JSON.parse(str.slice(i, j + 1)), pos: j + 1 };
  }
  if (str[i] === "'") {
    let j = i + 1, val = '';
    for (; j < str.length; j++) {
      if (str[j] === "'") {
        if (str[j + 1] === "'") { val += "'"; j++; continue; }
        return { value: val, pos: j + 1 };
      }
      val += str[j];
    }
    throw new YamlError('flow key 单引号没有闭合', line);
  }
  let j = i;
  while (j < str.length && str[j] !== ':') j++;
  const key = str.slice(i, j).trim();
  if (!key) throw new YamlError('空 key', line);
  return { value: key, pos: j };
}

function parseNode(lines, i, indent, depth) {
  if (depth > MAX_DEPTH) throw new YamlError('嵌套过深', lines[i] && lines[i].line);
  const first = lines[i];
  if (!first || first.indent !== indent) throw new YamlError('缩进不合法', first && first.line);
  if (first.text.startsWith('- ') || first.text === '-') return parseSeq(lines, i, indent, depth);
  return parseMap(lines, i, indent, depth);
}

function parseMap(lines, i, indent, depth) {
  const obj = {};
  let count = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlError('缩进跳级（该对齐上一层的键）', ln.line);
    if (ln.text.startsWith('- ') || ln.text === '-') throw new YamlError('mapping 里混进了 sequence 项', ln.line);
    const colon = topLevelColon(ln.text);
    if (colon < 0) throw new YamlError('mapping 行缺少 “: ”', ln.line);
    const key = ln.text.slice(0, colon).trim();
    if (!key) throw new YamlError('空 key', ln.line);
    if (key === '<<') throw new YamlError('不支持合并键 <<', ln.line);
    if (/[[\]{}&*!|>]/.test(key)) throw new YamlError(`key 里有非法字符：${key}`, ln.line);
    if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlError(`重复键 ${key}`, ln.line);
    const rest = ln.text.slice(colon + 1).trim();
    i++;
    if (rest === '') {
      if (i < lines.length && lines[i].indent > indent) {
        const r = parseNode(lines, i, lines[i].indent, depth + 1);
        obj[key] = r.value; i = r.i;
      } else {
        obj[key] = null;
      }
    } else {
      obj[key] = parseScalar(rest, ln.line, depth + 1);
      if (i < lines.length && lines[i].indent > indent) {
        throw new YamlError(`key “${key}” 的标量值后面跟了更深缩进`, lines[i].line);
      }
    }
    count++;
  }
  if (!count) throw new YamlError('空的 mapping', lines[i] && lines[i].line);
  return { value: obj, i };
}

function parseSeq(lines, i, indent, depth) {
  const arr = [];
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.indent !== indent || !(ln.text.startsWith('- ') || ln.text === '-')) break;
    const rest = ln.text === '-' ? '' : ln.text.slice(2).trim();
    if (!rest) {
      i++;
      if (i < lines.length && lines[i].indent > indent) {
        const r = parseNode(lines, i, lines[i].indent, depth + 1);
        arr.push(r.value); i = r.i;
      } else arr.push(null);
      continue;
    }
    if (isMapLine(rest)) {
      // `- key: value`：等价于把这一行提升到 indent+2 后当作 mapping 的首行。
      lines[i] = { indent: indent + 2, text: rest, line: ln.line };
      const r = parseMap(lines, i, indent + 2, depth + 1);
      arr.push(r.value); i = r.i;
      continue;
    }
    const val = parseScalar(rest, ln.line, depth + 1);
    i++;
    if (i < lines.length && lines[i].indent > indent) {
      throw new YamlError('sequence 标量项后面跟了更深缩进', lines[i].line);
    }
    arr.push(val);
  }
  return { value: arr, i };
}

function parseYaml(text, options) {
  const opts = options || {};
  if (typeof text !== 'string') throw new YamlError('输入必须是字符串');
  const maxBytes = opts.maxBytes || MAX_BYTES;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new YamlError(`YAML 超过 ${maxBytes} 字节`);
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  for (let idx = 0; idx < raw.length; idx++) {
    const original = raw[idx];
    if (/^[ \t]*\t/.test(original)) throw new YamlError('缩进里不许有 tab', idx + 1);
    const noComment = stripComment(original);
    if (!noComment.trim()) continue;
    const indent = noComment.match(/^ */)[0].length;
    const content = noComment.slice(indent).replace(/\s+$/, '');
    if (content === '---' || content === '...') throw new YamlError('不支持多文档分隔符', idx + 1);
    if (/^[&*!]/.test(content)) throw new YamlError('不支持锚点/别名/标签', idx + 1);
    lines.push({ indent, text: content, line: idx + 1 });
  }
  if (!lines.length) return {};
  if (lines[0].indent !== 0) throw new YamlError('根节点必须顶格', lines[0].line);
  const r = parseNode(lines, 0, 0, 0);
  if (r.i !== lines.length) throw new YamlError('文件末尾有多余内容', lines[r.i] && lines[r.i].line);
  return r.value;
}

module.exports = { parseYaml, YamlError, stripComment, topLevelColon };
