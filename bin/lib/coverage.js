'use strict';
/**
 * coverage.js —— 覆盖证明（2026-11-09）
 *
 * 为什么单独一个模块：**"覆盖是否可信"不能由调用方传个字符串决定**。
 * 否则任何人写 {level:'verified'} 就能把结论刷成 PRESENT —— 那就是可伪造的放行路径。
 *
 * 现在的实现原则：
 *   1. 只有本模块能产出"已验证覆盖"对象（私有 Symbol 品牌，外部无法伪造）；
 *   2. 产出前必须验证：字节边界连续、源身份、窗口、缺口、不可变生命周期；
 *   3. **这些验证目前都还没有实现**，所以 makeVerifiedCoverage 会**抛错**，
 *      也就是说当前不存在任何合法 verified 覆盖 —— 结论只能是 UNKNOWN。
 *      这是有意的：宁可永远 UNKNOWN，也不要一条能伪造的绿灯。
 *
 * 已知不成立的说法（不要写进文档）：哈希链只能证明"我读到的内容没被改"，
 * **不能**证明内容的来源，也不能证明"当时文件里就是这个"。
 */
const VERIFIED = Symbol('rdd.coverage.verified');

/** 仅供 tests 断言使用：判断某对象是不是本模块签发的已验证覆盖。 */
function isVerifiedCoverage(obj) {
  return !!(obj && typeof obj === 'object' && obj[VERIFIED] === true);
}

/**
 * 验证并签发"已验证覆盖"。当前**必然抛错**，因为验证条件未实现。
 * @param {object} evidence 需要包含 segments(连续字节区间与内容指纹)、source、window、gaps、lifecycle
 */
function makeVerifiedCoverage(evidence) {
  const missing = ['segments', 'source', 'window', 'gaps', 'lifecycle']
    .filter((k) => !evidence || evidence[k] === undefined);
  throw new Error('coverage-verification-not-implemented: 缺 ' + (missing.join(',') || '全部校验') +
    '；当前没有任何路径可以签发 verified 覆盖，结论只能是 UNKNOWN');
}

/** 读取方只接受本模块签发的对象；字符串/普通对象一律视为未验证。 */
function coverageLevel(obj) {
  return isVerifiedCoverage(obj) ? 'verified' : 'limited';
}

module.exports = { makeVerifiedCoverage, isVerifiedCoverage, coverageLevel };
