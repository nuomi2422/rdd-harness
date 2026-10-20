'use strict';
/**
 * schema.js —— 够用的 JSON Schema 子集校验器（零依赖）
 *
 * 支持关键字：type / required / properties / additionalProperties / items /
 *   enum / const / pattern / minLength / maxLength / minimum / maximum /
 *   minItems / maxItems / uniqueItems / oneOf / anyOf / allOf
 *
 * 不支持 $ref。测试卡 schema 刻意写成自包含的：外部输入不该能把校验器
 * 引到另一个文件去（那等于把「读哪个文件」交给了输入）。
 */

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validate(schema, value, path, errors) {
  path = path || '$';
  errors = errors || [];
  const push = (msg, p) => errors.push({ path: p || path, message: msg });

  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const actual = typeOf(value);
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = want.some((t) => (t === 'number' ? actual === 'number' || actual === 'integer' : actual === t));
    if (!ok) { push(`类型应为 ${want.join('|')}，实际 ${actual}`); return errors; }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) push(`必须等于 ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(value, e))) {
    push(`必须是 ${schema.enum.map((e) => JSON.stringify(e)).join(' / ')} 之一`);
  }
  if (schema.pattern && typeof value === 'string') {
    let re;
    try { re = new RegExp(schema.pattern); } catch { push('schema.pattern 自身不合法'); }
    if (re && !re.test(value)) push(`不匹配 ${schema.pattern}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) push(`长度小于 ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) push(`长度大于 ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) push(`小于最小值 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) push(`大于最大值 ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) push(`至少 ${schema.minItems} 项`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) push(`最多 ${schema.maxItems} 项`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) push('存在重复项');
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) push(`缺少必填字段 ${k}`, `${path}.${k}`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) validate(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) push(`不允许的字段 ${k}`, `${path}.${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(schema.additionalProperties, v, `${path}.${k}`, errors);
      }
    }
  }
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) validate(s, value, path, errors);
  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map((s) => validate(s, value, path, []));
    if (!results.some((e) => e.length === 0)) push('anyOf 没有一条通过：' + results.map((e) => e[0] && e[0].message).join(' | '));
  }
  if (Array.isArray(schema.oneOf)) {
    const pass = schema.oneOf.filter((s) => validate(s, value, path, []).length === 0).length;
    if (pass !== 1) push(`oneOf 必须恰好通过一条（实际 ${pass} 条）`);
  }
  return errors;
}

module.exports = { validate, typeOf };
