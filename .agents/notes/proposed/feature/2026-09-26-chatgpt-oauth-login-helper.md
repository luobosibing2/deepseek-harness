# Agent Note: ChatGPT subscription login helper

Status: proposed

English | [中文](2026-09-26-chatgpt-oauth-login-helper.zh.md)

## Problem

Harness already registers the OpenAI Codex OAuth provider and stores its credentials, but users lack a direct login entry point. The ordinary OpenAI API key provider uses a different authentication and request path. Credentials belong to a Harness home, while model settings belong to a profile; a successful login alone does not enable the provider in every profile.

## Proposal

Provide an optional, one-shot terminal plugin launched through an existing `dsh` profile and configuration overlay. It calls the existing authorization service for `llm-pi-ai/openai-codex`, presents the provider's browser, device-code, and manual-response flows, and exits after the interaction. Ordinary application launches do not load it. The [credential and authorization decision](../../implemented/architecture/2026-08-13-credential-records-and-authorization-flows.md) continues to own grant storage and refresh behavior; the [DeepSeek account decision](../../implemented/architecture/2026-09-14-deepseek-account-login.md) remains independent.

After the authorization service confirms persistence, the helper ensures that only the selected CLI profile has an `openai-codex` provider entry. It adds the built-in default entry when absent, preserves an existing entry and the default model, and reports a revision conflict instead of overwriting concurrent settings changes. An explicit `apiKeyEnv` on that provider is reported before authorization because it would override OAuth. The helper reports login and profile activation separately, including partial success when the grant is saved but settings cannot be updated.

The terminal identifies the selected profile and Harness home without printing tokens or a pasted authorization response. It does not read credentials from Codex, Pi, or browser files. A desktop profile that shares the home can use the saved grant after its existing model settings select OpenAI Codex; the helper does not edit that profile.

## Alternatives considered

**Add a login button to the model settings page.** This would activate the desktop profile directly, but it also needs remote transport for browser prompts, input, and cancellation, plus GUI validation. The requested fast path uses the terminal consumer and leaves that UI extension for a separate decision.

**Read another client's credential files.** Their private formats and refresh behavior are outside Harness control, and copying them would bypass the existing authorization service.

**Send the subscription token through the ordinary OpenAI provider.** The API key and Codex providers have different authentication and request paths. Reusing the registered Codex provider preserves the existing separation.

## Acceptance criteria

- A user can start the login overlay explicitly, complete the provider's supported authorization flow, and receive success only after the grant is saved; cancellation, input closure, and application stop terminate the helper without a false success message.
- First login enables `openai-codex` only in the selected CLI profile. Repeated login preserves its existing provider settings, other providers, and the default model; an explicit API key override or settings revision conflict is reported without silent replacement.
- Authorization failure leaves model settings unchanged. If settings activation fails after grant persistence, the helper retains the grant, reports partial success and a recovery action, and exits with failure status.
- Keyless tests exercise the shipped `dsh` configuration entry, interaction, exit status, profile isolation, and persisted results. Any real-account verification is reported separately from those tests.

## Risks

Browser authorization depends on the upstream provider and user interaction. Grant persistence and profile settings are separate writes, so activation can fail after login succeeds. Shared credentials do not imply shared model settings, and a working request in one profile does not establish desktop readiness or access to every model.
