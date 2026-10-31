# Deepsea Liquid Glass theme

This example plugin registers a light blue liquid-glass appearance through `context.ui.registerTheme()`. It changes existing Pico semantic color/surface roles and the framework-owned material backdrop; it adds no UI markup, custom CSS, or host DOM behavior. Pico's existing layout, controls, focus handling, and scrolling remain host-owned.

## DeepSeek brand asset usage

This theme displays a DeepSeek whale icon. **Do not use this theme unless you are actually using a DeepSeek service, such as its models or API.** Pico's ability to connect to DeepSeek alone does not mean that every installation meets this condition. If you are not using a DeepSeek service, choose another theme.

The icon uses the whale path and color extracted from [DeepSeek-LLM `images/logo.svg`](https://github.com/deepseek-ai/DeepSeek-LLM/blob/main/images/logo.svg), without the wordmark. DeepSeek's [brand asset guidelines](https://github.com/deepseek-ai/awesome-deepseek-integration/blob/main/docs/_logo%20svg/guidelines.md) require actual integration and prohibit misleading claims of affiliation or endorsement, impersonation, and arbitrary modification of its artwork. Consult those guidelines and verify that your use of this extracted icon is permitted before using or redistributing it. DeepSeek's rights and conditions for its brand assets remain separate from those applicable to Pico's own code.

This is an independent Pico example, not an official DeepSeek theme or endorsement.

`webui/theme-assets.json` lists the relative image resources that the deployment publisher must include. The background is an original, self-contained blue gradient; the whale is a separate icon used by the host in place of the Pico mark. `webui/index.html` is the package entry for the publisher. No JavaScript is needed for this theme-only plugin.
