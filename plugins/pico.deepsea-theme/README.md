# Deepsea Liquid Glass theme

This example plugin registers a light blue liquid-glass appearance through `context.ui.registerTheme()`. It changes existing Pico semantic color/surface roles and the framework-owned material backdrop; it adds no UI markup, custom CSS, or host DOM behavior. Pico's existing layout, controls, focus handling, and scrolling remain host-owned.

The whale icon uses the original whale path and color extracted from [DeepSeek-LLM `images/logo.svg`](https://github.com/deepseek-ai/DeepSeek-LLM/blob/main/images/logo.svg), without the wordmark. DeepSeek's [brand asset guidelines](https://github.com/deepseek-ai/awesome-deepseek-integration/blob/main/docs/_logo%20svg/guidelines.md) say to use its assets only when actually integrating DeepSeek models or APIs, not to imply official affiliation, and not to modify the artwork. Pico supports DeepSeek API integrations; this theme is an independent Pico example and is not an official DeepSeek theme or endorsement.

`webui/theme-assets.json` lists the relative image resources that the deployment publisher must include. The background is an original, self-contained blue gradient; the whale is a separate icon used by the host in place of the Pico mark. `webui/index.html` is the package entry for the publisher. No JavaScript is needed for this theme-only plugin.
