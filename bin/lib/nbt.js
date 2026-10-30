'use strict';
/**
 * nbt.js —— 只读 NBT 解析（只为读 MC level.dat 的 Difficulty / GameRules）
 *
 * 为什么存在：zero-start 要证明 /difficulty 与 /gamerule 真的落地。停机是强杀进程，
 * 不 /save-all 的话磁盘上的 level.dat 还是母版旧值 —— 于是「命令没生效」与「没落盘」
 * 长得一模一样。这个模块让判据能读真实产物，而不是信命令的 exit code。
 *
 * 用法：const { readLevelInfo } = require('./lib/nbt');
 *       readLevelInfo('…/saves/live/level.dat') -> { Difficulty, keepInventory, LevelName, GameType, GameRules }
 * 失败一律返回 { error }，绝不抛（证据采集不能把主流程带崩）。
 */
const fs = require('fs');
const zlib = require('zlib');

function parse(buf) {
  let p = 0;
  const u8 = () => buf[p++];
  const i16 = () => { const v = buf.readInt16BE(p); p += 2; return v; };
  const i32 = () => { const v = buf.readInt32BE(p); p += 4; return v; };
  const i64 = () => { const v = Number(buf.readBigInt64BE(p)); p += 8; return v; };
  const str = () => { const n = buf.readUInt16BE(p); p += 2; const s = buf.toString('utf8', p, p + n); p += n; return s; };
  function payload(t) {
    switch (t) {
      case 1: return buf.readInt8(p++);
      case 2: return i16();
      case 3: return i32();
      case 4: return i64();
      case 5: return buf.readFloatBE((p += 4) - 4);
      case 6: return buf.readDoubleBE((p += 8) - 8);
      case 7: { const n = i32(); p += n; return null; }
      case 8: return str();
      case 9: { const et = u8(); const n = i32(); const a = []; for (let i = 0; i < n; i++) a.push(payload(et)); return a; }
      case 10: { const o = {}; for (;;) { const et = u8(); if (et === 0) break; const name = str(); o[name] = payload(et); } return o; }
      case 11: { const n = i32(); const a = []; for (let i = 0; i < n; i++) a.push(i32()); return a; }
      case 12: { const n = i32(); const a = []; for (let i = 0; i < n; i++) a.push(i64()); return a; }
      default: throw new Error('bad tag ' + t + ' at ' + p);
    }
  }
  const t = u8();
  if (t !== 10) throw new Error('root tag is not compound: ' + t);
  str();
  return payload(10);
}

function readLevelInfo(file) {
  try {
    if (!fs.existsSync(file)) return { error: 'MISSING ' + file };
    let raw = fs.readFileSync(file);
    if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
    const root = parse(raw);
    const d = root.Data || {};
    const gr = d.GameRules || {};
    return {
      file,
      LevelName: d.LevelName === undefined ? null : d.LevelName,
      Difficulty: d.Difficulty === undefined ? null : d.Difficulty,
      keepInventory: gr.keepInventory === undefined ? null : gr.keepInventory,
      GameType: d.GameType === undefined ? null : d.GameType,
      GameRules: gr,
    };
  } catch (e) {
    return { error: 'PARSE_FAIL ' + e.message, file };
  }
}

/**
 * patchLevel(file, { difficulty, keepInventory }) —— 直接改 level.dat 的难度与 keepInventory。
 *
 * 为什么不用 /difficulty、/save-all：2026-10-25 两次短测证明聊天命令通道会丢 RETURN
 * （日志里留下 "save-all flush<--[此处]" 这种没提交的输入），于是「命令没生效」与
 * 「没落盘」分不开。NBT 是顺序结构、没有绝对偏移，改同长度字节 / 换等值字符串都安全。
 * 只改副本世界，绝不碰 saves/live。
 */
function patchLevel(file, opts) {
  try {
    if (!fs.existsSync(file)) return { error: 'MISSING ' + file };
    const raw = fs.readFileSync(file);
    const gz = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
    let buf = gz ? zlib.gunzipSync(raw) : Buffer.from(raw);
    const changed = [];

    if (typeof opts.difficulty === 'number') {
      const i = buf.indexOf('Difficulty', 0, 'utf8');
      const okName = i >= 2 && buf[i - 2] === 0 && buf[i - 1] === 10; // 名字长度必须是 10（避开 DifficultyLocked）
      if (!okName) return { error: 'NOT_FOUND Difficulty' };
      const pos = i + 10;
      if (buf[pos] !== opts.difficulty) { buf[pos] = opts.difficulty; changed.push('Difficulty=' + opts.difficulty); }
    }

    if (typeof opts.keepInventory === 'string') {
      const want = opts.keepInventory;
      const i = buf.indexOf('keepInventory', 0, 'utf8');
      const okName = i >= 2 && buf[i - 2] === 0 && buf[i - 1] === 13;
      if (!okName) return { error: 'NOT_FOUND keepInventory' };
      const lp = i + 13;
      const vlen = buf.readUInt16BE(lp);
      const val = buf.toString('utf8', lp + 2, lp + 2 + vlen);
      if (val !== want) {
        buf = Buffer.concat([buf.subarray(0, lp), Buffer.from([0, want.length]), Buffer.from(want, 'utf8'), buf.subarray(lp + 2 + vlen)]);
        changed.push('keepInventory=' + want);
      }
    }

    if (typeof opts.levelName === 'string') {
      const want = opts.levelName;
      const i = buf.indexOf('LevelName', 0, 'utf8');
      const okName = i >= 2 && buf[i - 2] === 0 && buf[i - 1] === 9; // 名字长度必须是 9
      if (!okName) return { error: 'NOT_FOUND LevelName' };
      const lp = i + 9;
      const vlen = buf.readUInt16BE(lp);
      const val = buf.toString('utf8', lp + 2, lp + 2 + vlen);
      if (val !== want) {
        buf = Buffer.concat([buf.subarray(0, lp), Buffer.from([0, want.length]), Buffer.from(want, 'utf8'), buf.subarray(lp + 2 + vlen)]);
        changed.push('LevelName=' + want);
      }
    }

    if (opts.seed !== undefined && opts.seed !== null) {
      // 1.18+ 的世界种子不在顶层 RandomSeed，而在 WorldGenSettings.seed（TAG_Long，8 字节 BE）。
      // 先定位 WorldGenSettings，再找它之后的第一个 `\x00\x04seed`，避免撞到别的同名字段。
      const wg = buf.indexOf('WorldGenSettings', 0, 'utf8');
      if (wg < 0) return { error: 'NOT_FOUND WorldGenSettings' };
      const i = buf.indexOf('seed', wg, 'utf8');
      const okName = i > wg && buf[i - 2] === 0 && buf[i - 1] === 4; // 名字长度 4
      if (!okName) return { error: 'NOT_FOUND WorldGenSettings.seed' };
      const pos = i + 4;
      const next = Buffer.alloc(8);
      next.writeBigInt64BE(BigInt.asIntN(64, BigInt(opts.seed)), 0);
      if (!buf.subarray(pos, pos + 8).equals(next)) {
        next.copy(buf, pos);
        changed.push('seed=' + String(opts.seed));
      }
    }

    if (!changed.length) return { file, changed: [], note: 'already-set' };
    const out = gz ? zlib.gzipSync(buf) : buf;
    fs.writeFileSync(file, out);
    const back = readLevelInfo(file);
    return { file, changed, after: { Difficulty: back.Difficulty, keepInventory: back.keepInventory } };
  } catch (e) {
    return { error: 'PATCH_FAIL ' + e.message, file };
  }
}

module.exports = { readLevelInfo, patchLevel };
