# coverage.js 对外契约（ABI 一页）

> 用途：让生产侧（exp-runner）按契约产出 evidence，不必猜字段。
> 判定权只在 `coverage.js`：**它说签发才算 verified**，调用方传字符串一律无效。

## 1. 入口

```js
const { makeVerifiedCoverage, isVerifiedCoverage, coverageLevel }
  = require('./lib/coverage');
const cov = makeVerifiedCoverage(evidence); // 成功：冻结对象；失败：throw
```

## 2. 入参 `evidence`

```ts
{
  bindings: {                    // 四个都必须是非空字符串，缺一 → COVERAGE_UNKNOWN
    world_id: string,
    server_session: string,
    companionId: string,
    requestId: string,           // 复用 llm_request.data.requestId，不新造
  },

  window: {
    stimulusSentAt: string,      // ISO；窗口起点=刺激送出
    stopEnqueuedAt: string,      // ISO；窗口止点=停止入队
    start: Record<Stream, number>, // 每流窗口起点字节偏移
    end:   Record<Stream, number>, // 每流窗口止点字节偏移（含，即下一个未读位置）
    completeness: 'verified-for-observed-window' | 'partial' | 其它
                                 // 只有字面量 'verified-for-observed-window' 才可能判 verified
  },

  segments: Record<Stream, {
    segments: Array<{ from: number, to: number, fingerprintMatch?: boolean }>,
                                 // 必须按 from 升序首尾相接：首段.from===window.start、
                                 // 末段.to===window.end、中间 from===前段.to
    broken?: number,             // 必须为 0（>0 = 段比对失败）
    halfLine?: boolean,          // true = 最后一行没写完，拒绝
  }>,

  gaps: Record<Stream, number>,  // 每流必须显式给 0；缺键/非数值=不可判 → 拒绝

  lifecycle: {
    closed: boolean,             // 必须 true（窗口已结束）
    replays?: number,            // 必须 0（同 event_id 在窗口内出现两次即 >0）
    fileIds: Record<Stream, { start: string|number, end: string|number }>,
                                 // 读取前/后的文件身份（如 inode）；不一致=换文件 → 拒绝
  },
}

type Stream = 'tools' | 'context' | 'events' | 'ai' | 'rdd' | 'expmem' | 'instrumentation';
```

## 3. 返回对象（只在成功时）

```ts
{
  contentIntegrity: 'verified',                       // 复读一致
  windowCompleteness: 'verified-for-observed-window' | 'unproven',
  scope: 'content-immutable-since-read',              // 只能证明内容自读取后没变
  files: Stream[],
  bindings: { ... },
  observedWindow: { scope: 'observed-bytes-only', start, end, stimulusSentAt, stopEnqueuedAt },
}
```
对象被 `Object.freeze`；外部无法构造（私有 Symbol 品牌）。`coverageLevel(cov)`：`verified` / `content-only` / `limited`。

## 4. 抛错边界

| 情形 | 错误 | 消费端应映射为 |
|---|---|---|
| 绑定键缺失/空 | `Error.code='COVERAGE_UNKNOWN'` | **UNKNOWN**（不是拒绝） |
| 缺 window/时刻/字节位 | `COVERAGE_REJECTED` | UNKNOWN/limited |
| gaps 缺键或 ≠0 | `COVERAGE_REJECTED` | UNKNOWN |
| 段不连续/首尾不合窗口/半行/broken>0/指纹不符 | `COVERAGE_REJECTED` | UNKNOWN |
| 生命周期未闭合/重放/换文件 | `COVERAGE_REJECTED` | UNKNOWN |

**没有** `level` 入参、没有 `skipCheck`、没有 `force`。

## 5. 生产者怎么算（见 `coverage-producer-sample.js`）

1. 每流读前 stat（inode/size）→ 游标从 0 读到末尾；
2. 尾字节非 \n ⇒ `halfLine=true`；
3. 复读同区间算 sha256 比对 ⇒ `segments[].fingerprintMatch`；
4. 读后 stat，inode 变化 ⇒ `fileIds.start≠end`（签发会被拒）；
5. 行内 `event_id` 重复 ⇒ `lifecycle.replays>0`；
6. 缺的流**不许补 0**：直接不写该流 ⇒ 签发按“流未消费”拒绝。
