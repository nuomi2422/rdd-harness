'use strict';
/**
 * registry.js —— registry.json 的唯一加载/解析层
 *
 * 为什么要有这一层：
 *   2026-10-10 之前 registry.json 的 roots / standards / docNumbers 全是
 *   `D:\rdd\...` 绝对路径，工作区一搬家、换个账号、拷给另一台机器，整套门禁
 *   就静默指向不存在的目录（或更糟：指向另一份旧副本）。
 *
 * 现在规则只有一条：
 *   **registry 里所有路径都相对 RDD 根；RDD 根相对本文件。**
 *   - registry.paths.rootAnchor 默认 "../.."（harness/rdd-harness -> rdd）
 *   - 环境变量 RDD_ROOT（名字可由 registry.paths.envOverride 改）优先，
 *     用于 CI / 临时拷贝 / 另一台机器
 *   - 绝对路径仍然接受（兼容旧脚本/外部工具），但 selftest 会警告
 *
 * 消费方式：
 *   const reg = require('./lib/registry').load();
 *   reg.roots.workspace        // 已解析成绝对路径（旧代码不用改）
 *   reg.rootsRaw.workspace     // 注册表里的原值（相对）
 *   reg.resolve('docs/xxx')    // 相对 RDD 根解析
 *   reg.toRelative(abs)        // 打日志用，尽量输出相对路径
 */

const fs = require('fs');
const path = require('path');

const HARNESS_DIR = path.resolve(__dirname, '..', '..');
const REGISTRY_FILE = path.join(HARNESS_DIR, 'registry.json');

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readJson(file) {
  return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
}

/** 只解析「路径主体」，保留 `§二目录表` 这类给人看的补注 */
function splitAnnotation(value) {
  const s = String(value);
  const m = s.match(/^([^§（(]*?)(\s*[§（(].*)$/);
  return m ? { file: m[1].trim(), suffix: m[2] } : { file: s.trim(), suffix: '' };
}

function load(options) {
  const opts = options || {};
  const file = path.resolve(opts.file || REGISTRY_FILE);
  const raw = readJson(file);
  const baseDir = path.dirname(file);

  const anchor = (raw.paths && raw.paths.rootAnchor) || '../..';
  const envName = (raw.paths && raw.paths.envOverride) || 'RDD_ROOT';
  const envValue = process.env[envName];
  const root = envValue ? path.resolve(envValue) : path.resolve(baseDir, anchor);

  const resolve = (p) => {
    if (p === undefined || p === null) return p;
    const s = String(p);
    if (!s) return s;
    return path.isAbsolute(s) ? path.normalize(s) : path.resolve(root, s);
  };

  const reg = Object.assign({}, raw, {
    _meta: { file, baseDir, root, envName, envApplied: !!envValue, anchor },
    rootsRaw: Object.assign({}, raw.roots || {}),
    roots: {},
    resolve,
    toRelative(abs) {
      if (!abs) return abs;
      const rel = path.relative(root, path.resolve(String(abs)));
      return rel && !rel.startsWith('..' + path.sep) && rel !== '..' ? rel.replace(/\\/g, '/') : String(abs);
    },
  });

  for (const [k, v] of Object.entries(raw.roots || {})) reg.roots[k] = resolve(v);

  if (raw.standards) {
    reg.standards = Object.assign({}, raw.standards);
    for (const k of ['source', 'mirror']) if (raw.standards[k]) reg.standards[k] = resolve(raw.standards[k]);
  }

  if (raw.docNumbers) {
    const dn = Object.assign({}, raw.docNumbers);
    reg.docNumbersRaw = Object.assign({}, raw.docNumbers);
    if (dn.root) dn.root = resolve(dn.root);
    if (dn.ledger) dn.ledger = resolve(dn.ledger);
    if (Array.isArray(dn.registerIn)) {
      dn.registerIn = dn.registerIn.map((entry) => {
        const { file: f, suffix } = splitAnnotation(entry);
        return resolve(f) + suffix;
      });
    }
    reg.docNumbers = dn;
  }

  return reg;
}

module.exports = { HARNESS_DIR, REGISTRY_FILE, load, resolve: (p) => load().resolve(p), splitAnnotation };
