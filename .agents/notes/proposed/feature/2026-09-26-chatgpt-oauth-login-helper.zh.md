# Agent Note: ChatGPT 订阅登录辅助入口

Status: proposed

[English](2026-09-26-chatgpt-oauth-login-helper.md) | 中文

## Problem

Harness 已注册 OpenAI Codex OAuth 提供方并能保存其凭证，但用户缺少直接的登录入口。普通 OpenAI API Key 提供方使用不同的认证与请求路径。凭证属于 Harness home，模型设置属于 profile；一次成功登录并不会在所有 profile 中启用提供方。

## Proposal

提供通过现有 `dsh` profile 和配置 overlay 显式启动的一次性终端插件。它调用现有授权服务处理 `llm-pi-ai/openai-codex`，展示提供方支持的浏览器、设备码和手动响应流程，并在交互结束后退出。普通应用启动不会加载它。[凭证与授权决策](../../implemented/architecture/2026-08-13-credential-records-and-authorization-flows.zh.md)继续负责授权凭证的存储与刷新；[DeepSeek 账号决策](../../implemented/architecture/2026-09-14-deepseek-account-login.zh.md)保持独立。

授权服务确认持久化后，辅助插件仅确保选定的 CLI profile 包含 `openai-codex` 提供方配置。缺少配置时添加内置默认项，已有配置及默认模型保持不变；遇到并发设置修订冲突时报告错误，不覆盖其他修改。若该提供方显式设置 `apiKeyEnv`，则在授权前报告冲突，因为它会覆盖 OAuth。辅助插件分别报告登录与 profile 启用结果；凭证已保存但设置更新失败时报告部分成功。

终端展示选定的 profile 和 Harness home，但不输出 token 或用户粘贴的授权响应。它不读取 Codex、Pi 或浏览器的私有凭证文件。共享同一 home 的桌面 profile 可以在现有模型设置中选用 OpenAI Codex，从而使用已保存的授权凭证；辅助插件不修改该 profile。

## Alternatives considered

**在模型设置页添加登录按钮。** 这能直接启用桌面 profile，但还需要传递浏览器提示、输入和取消的远程交互，并完成 GUI 验证。用户要求的最快路径使用终端消费者，界面扩展留待单独决定。

**读取其他客户端的凭证文件。** 这些私有格式及刷新行为不由 Harness 控制；复制凭证还会绕过现有授权服务。

**通过普通 OpenAI 提供方发送订阅 token。** API Key 与 Codex 提供方的认证和请求路径不同。复用已注册的 Codex 提供方能保持两条路径独立。

## Acceptance criteria

- 用户可以显式启动登录 overlay，完成提供方支持的授权流程，并且仅在凭证保存后收到成功提示；取消、输入关闭和应用停止会终止辅助插件，不显示虚假的成功结果。
- 首次登录只在选定的 CLI profile 中启用 `openai-codex`。重复登录保留已有提供方设置、其他提供方及默认模型；显式 API Key 覆盖和设置修订冲突会被报告，不会静默替换配置。
- 授权失败不修改模型设置。授权凭证已保存而设置启用失败时，辅助插件保留凭证、报告部分成功和恢复操作，并以失败状态退出。
- 无密钥测试覆盖正式 `dsh` 配置入口、交互、退出状态、profile 隔离和持久化结果。真实账号验证与这些测试分别报告。

## Risks

浏览器授权依赖上游提供方与用户交互。凭证持久化与 profile 设置是两次独立写入，因此登录成功后仍可能无法启用提供方。共享凭证不等于共享模型设置；某个 profile 的请求成功，也不能证明桌面端已就绪或所有模型均可用。
