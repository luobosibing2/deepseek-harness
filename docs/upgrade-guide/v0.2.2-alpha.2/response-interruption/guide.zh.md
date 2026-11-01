---
kind: upgrade-guide
description: 自定义 Agent 实现必须提供响应中断能力，请求恢复监听器会收到响应或回合的取消信号。
---

# Agent 实现与恢复监听器的响应中断迁移

[English](guide.md) | 中文

## 变更

`Agent` 必须提供 `interruptResponse(): boolean`。默认 AgentLoop 请求取消活动模型响应或恢复等待，记录该响应，然后在同一回合进入下一次 pre-step。调用方另行排入 steering。该方法不取消工具、准备过程、维护任务或整个回合。

`agent/request-error.payload.signal` 会因整个回合取消或响应中断而取消；此前它只表示回合取消。恢复监听器不能仅凭这个信号推断回合已经结束。现有 `cancel()`、`steer()` 和 `followup()` 的含义保持不变。

## 迁移

1. 为自定义 `Agent` 实现与带类型的测试替身补充 `interruptResponse()`。只有请求中断符合条件的响应时才返回 `true`；没有可中断响应或此前已请求中断时返回 `false`。请求确认不能证明收束已经完成。
2. 在 `agent/request-error` 监听器中，把 `payload.signal` 传给可取消的恢复操作，并在取消后停止重试。调用方需要整个回合结果时，使用 Agent 生命周期或持久回合事件；不要把所有信号原因都断言为回合取消原因。
3. 需要立即纠正时，先通过 `steer()` 排入带标识的消息，再请求响应中断。保留正常 pre-step 准入，并以整个回合的取消为优先。
4. 验证等待中的响应和恢复等待可以停止，而同一回合继续处理纠正。验证活动工具与普通 steering 不受影响。[Agent API](../../../../packages/core/agent/README.zh.md#drive-an-agents-conversation) 定义返回值与收束观察方式。
