# dsh-guard-repeat-output

**在模型的重复崩塌烧掉你的上下文之前拦住它。**

一个 [DSH](https://github.com/deepseek-ai) 宿主侧守卫：监视模型输出流，在退化重复刚出现时就切断它。

**语言：** [English](./README.md) | 简体中文

---

## 问题

模型有时会卡住。它不再把思路讲完，而是开始一遍遍吐同一句话：

```
let me write the call let me write the call let me write the call let me write ...
```

这不是罕见的边缘情况。生产服务器上捕获过两次真实事故：

| 长度 | 形态 |
|---|---|
| 1,371,962 字符 | `"let me produce"` × 27,269 —— 纯重复 |
| 250,506 字符 | `"let me write"` × 1,958 与 `"let me write the call"` × 1,951 交替 |

循环里没有任何东西察觉。这一轮继续生成——也继续计费——直到模型自己停下，或有人按下取消。这些 token 随后全部留在上下文窗口里，把真正重要的工作挤出去。

## 它做什么

守卫在流式输出到达时评估一个滑动窗口，分三个层次行动。

**流式输出进行中：**

1. **净化** —— 黑名单码点（控制字符、U+FFFD、零宽填充符、孤立代理项）在转发前从每个 delta 中剥离，因此永远无法进入日志。与重复不同，这一步不需要统计判断。*密集*爆发——一段不间断的长串，或单个 delta 中占比过高——本身就是崩塌证据：一个连吐 200 个 NUL 字节的模型已经废了，无论它是否同时在循环。
2. **检测** —— 在 reasoning 通道上滑动窗口，检查短语重复、低信息密度、分段结构。
3. **丢弃** —— 崩塌的尝试被结算为仅日志事件，而不是呈现为消息，因此没有任何退化文本进入派生历史。
4. **重试** —— 请求以**完全原样**重新发起，作为一次干净的重生成。路由永不改写：见[为什么重试不降低档位](#为什么重试不降低档位)。
5. **收尾** —— 重试预算耗尽后，流在估计的起点处被切断，并请模型作结，使这一轮仍然完成而不是失败。

**对一个已经被污染的会话，事后补救：**

6. **清理** —— `/guard-cleanup` 命令扫描会话日志，找出**已经落盘**的退化 reasoning，用一段简短说明遮蔽它，使用的正是压缩（compaction）所用的 surface 替换机制。这些块因此离开模型可见的 surface，下一次请求不再重放它们——而 append-only 日志保留原始字节以供审计。**不删除任何东西。**

   它存在的原因：实时守卫无法修复**在它安装之前**已经造成的损害。在一次真实事故中，守卫上线*之后*实测发现：活动上下文里仍带着 **205,942 字符**的退化 reasoning（一个 113,586 字符、一个 92,356 字符的块），之后每一次请求都在重放它们——正是让崩塌复发的引子。

   **安全规则：** 持有 tool-call 块的 assistant 消息会被**跳过**，而不是被遮蔽。遮蔽它会让它的 `tool/result` 回复变成孤儿，而 provider 会拒绝没有对应调用的 tool result——且真实的 surface fold 会**静默接受**这个孤儿，所以这个危险不会被下游发现。失控的 reasoning 天生不含 tool-call（事故中那个 725KB 的块产生了零次调用），因此这条规则几乎没有代价。

### 为什么重试不降低档位

早期版本在重试时把 reasoning 档位降低一档，理论依据是「相同的请求会复现相同的崩塌」。经过真实流量测量后，该机制已被移除：

| 观察项 | 结果 |
|---|---|
| 降档后解决的 conviction | 9 / 9 |
| 其中之后**再次**崩塌的会话 | **6 / 9（67%）** |
| 适配器**拒绝**所提议档位的 conviction | 7 次，其中 **3 次直接杀死该轮** |

**67% 的复发率是决定性数字**：降低的档位没有带来任何免疫，真正起作用的是「丢弃并重新生成」，而降档并不配占这个位置。与此同时，每一次拒绝都是同一类失败——适配器拒绝一个模型未声明的档位（`does not support reasoning effort "medium"`）——把一个已经拦下的崩塌变成死轮。**一个恢复手段能杀死它正在抢救的那一轮，还不如只丢弃。**

[`verify/effort-necessity.mjs`](./verify/effort-necessity.mjs) 被保留下来，使这个结论保持可证伪，而不是变成传说。

## 安装

```bash
npm install dsh-guard-repeat-output
```

然后在你的 DSH profile 中挂载它。本包自带一个 Cordis patch 层：

```yaml
- insert:
    - id: guard-repeat-output
      name: 'dsh-guard-repeat-output'
      config:
        # 完整且带注释的默认值见 cordis.patch.yml
        truncateChannels: ['reasoning']
        maxDegenerationRetries: 2
```

## 配置

每个选项都在 [`cordis.patch.yml`](./cordis.patch.yml) 中就地文档化，包括每个默认值背后的实测依据。最要紧的几个：

| 选项 | 默认值 | 含义 |
|---|---|---|
| `truncateChannels` | `['reasoning']` | 守卫可以动手的通道。其它一切仅观察。 |
| `modelIncludes` | `['deepseek']` | 模型 id 的子串作用域；**空列表表示匹配所有模型**。 |
| `maxDegenerationRetries` | `2` | 回退到截断前的丢弃重试次数。重试不改动路由。 |
| `sanitizeGarbage` | `true` | 转发前从每个 delta 剥离黑名单码点。 |
| `garbageRunChars` | `32` | 不间断乱码串达到此长度即计为崩塌证据。 |
| `garbageRatio` | `0.5` | 单个 delta 中乱码占比达到此值即计为崩塌证据。 |
| `cleanupCommand` | `true` | 注册 `/guard-cleanup` 以做事后净化。 |
| `holdbackChars` | `4096` | 释放前扣留多少字符，使切点能落在真正的起点。 |
| `copyDir` | `null` | 可选的侧车副本，保存被丢弃的文本，用于事后误报分析。**永不**回读进请求。 |
| `logPath` | `null` | 可选的 JSONL 日志，记录每一次 conviction，用于事后诊断。 |

> **注意 `modelIncludes` 的两种「空」**：`[]` 是**有意**表示「匹配所有模型」；而 `['   ']`（写了内容但全是空白）会被**拒绝并报错**，因为它看起来是想限定范围却写错了——静默放宽成「全部模型」是与意图相反、且更危险的方向，因为所有阈值都只在 DeepSeek 输出上标定过。

### 可移植路径

`copyDir` 和 `logPath` 在每个平台上解析方式一致，因此本包不对 Linux 目录布局做任何假设：

| 配置值 | 解析为 |
|---|---|
| `logs/guard.log`（相对） | `$DSH_HOME/logs/guard.log`，否则 `~/.dsh/logs/guard.log` |
| `$DSH_HOME/logs/guard.log` | harness home |
| `~/logs/guard.log` | 操作系统 home 目录 |
| `/var/log/guard.log` | 原样使用（POSIX 绝对路径） |
| `C:\logs\guard.log` | 原样使用（Windows 绝对路径） |
| `null` | 功能关闭 |

相对路径解析在 harness home 之下，而不是进程 CWD（后者每次启动都不同）。路径从不通过字符串拼接组装，因此 Windows 路径不会得到混合分隔符；侧车文件名也会净化掉在某些平台上非法的字符（包括保留设备名），因此侧车不会只在某个操作系统上静默失败。

### 设计说明

- **重试永不触碰路由。** 守卫的恢复手段必须不可能让它正在抢救的那一轮失败；提议一个模型未声明的 reasoning 档位恰恰会这样。
- **检测按模型 id 限定作用域**，因此守卫不会介入它未曾标定的模型。
- **日志与侧车副本是诊断，永远不是控制路径。** 文件系统不可写时，守卫继续工作并保持静默。

## 扩展点

- `llm/stream` —— 净化、检测与流干预。
- `agent/request-error` —— 重新发起一个因退化而被终止的请求。
- `agent/pre-step` —— 当指令尚未挂起时的兜底重注入。
- `commands`（经 `ctx.inject`）—— 在服务可用时注册 `/guard-cleanup`。

守卫**不注册** `agent/request` 监听器：重新发起的请求与崩塌的那一次**刻意保持一致**。

## 测试

```bash
# 语料是真实捕获的模型输出，不随包发布：把第一个参数指向任何包含
# legit/L00001.txt 与 unreg/deg1-seq2608.txt 的目录树。
node verify/integration.mjs <corpusRoot>   # 端到端检测与干预
node verify/mutations.mjs                  # 检测器对照：每一支都必须能够失败
node verify/cross-platform.mjs             # 路径解析与文件名安全
node verify/maintenance.mjs                # 净化与事后清理（自包含）
node verify/config.mjs                     # 配置校验（自包含）
```

`verify/effort-necessity.mjs` 是运维诊断脚本而非自包含测试：它读取一份实时守卫日志和一个 DSH sessions 根目录，重新推导上面的测量结果。

## 许可证

MIT
