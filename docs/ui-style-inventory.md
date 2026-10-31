# WebUI 样式清单：阶段 1

本文记录当前源码中的样式归属，为后续统一视觉基线提供可审阅的范围。它是源码清单，不代表设计已批准改变。现有 CSS 拆分规则和导入顺序说明见 [ui-styles.md](ui-styles.md)；本文关注样式实际来源、使用位置、可以归并的部分，以及尚待核实的对应关系。

## 分类说明

- **区域专属**：依赖特定页面、面板、弹层内容或布局的样式。保留各自结构、定位、间距和交互。
- **共享单一控件**：面向单个可复用控件的共同基线，例如插件 Select 或 Switch。优先保持原有外观，已确认的统一外观可有少量变化。
- **多变体**：外观相近但承担不同语义或状态的多个控件/容器，例如普通按钮与插件按钮、不同弹层。先保留各自变体；仅可归并经核实相同的基础值。

## 区域专属

| 区域 / 控件 | 使用位置 | 样式来源 | 当前文字、容器与状态特征 | 应保留 / 可归并 | 尚待核查 |
| --- | --- | --- | --- | --- | --- |
| 模型选择器与模型列表面板 | Composer 模型选择、Adapter/模型选择对话面板 | `src/web/styles/regions/model-selection.css:1-248`；结构和 portal 在 `src/web/model-selection.tsx:470-704` | 触发器 32px 高、12px 字号；模型面板使用双列网格、独立滚动、10px 圆角；hover/选中使用浅绿背景；不可用和错误状态为棕红色文字 | 保留定位、面板列宽、尺寸、参数呈现和状态语义。重复出现的色值/边框可在确认计算后抽 token | 是否要与插件 Select 统一仅是视觉决定；组件语义和交互不同，不据外观相似推断为同一控件 |
| 模型 More 参数面板 | Composer 的 More 参数入口；移动布局会将参数 portal 到 body | `src/web/styles/regions/model-selection.css:87-118`；结构在 `src/web/model-selection.tsx:550-619` | 控件式按钮；参数面板 fixed 定位，宽度最多 280px、最大高度 60vh/360px，10px 间距；表面背景、边框、圆角和阴影与工具栏 popover 共用 `src/web/styles/shared/popover.css` | **已确认设计：More 保持控件式按钮。**保留触发器控件式外观、锚定/定位、移动端用途、参数排序与可见规则 | `More` 对应历史 `ModelParameterOthers`，当前承担额外模型参数；该历史对应关系已确认 |
| Executor 远程连接表单内容 | New Thread / Executor 配置中的远程连接区、现存连接卡片与新增表单 | `src/web/styles/regions/dialog-content.css:26-74`；表单结构和 Connect 按钮在 `src/web/App.tsx:5090-5257` | 连接区有顶部边界、较大分隔间距；连接卡片为灰白底和 14px 圆角；连接名、地址、路径使用不同文字层级；提交按钮显示 `Connect Executor` / `Connecting…` | 保留表单字段、反馈、连接卡片信息层级与动作状态；卡片背景/边框可候选归并到通用容器基线 | 本文仅将其记录为远程 Executor 连接表单的 Connect 文案和按钮；没有依据认定它就是其他上下文提及的 Connect 对象或按钮 |
| ChatGPT Provider 连接设置 | Runtime 设置中的 Providers 页面及 ChatGPT Plan provider 设置 | 页面容器由 `src/web/styles/regions/settings.css` 提供；ProviderSettings 在 `src/web/provider-settings.tsx:40-120`；ChatGPT provider entry 在 `src/plugins/chatgpt-plan/webui-entry.tsx:336-359` | provider 列表使用可展开实例卡；ChatGPT 未连接时显示 Continue/Reconnect primary action，已连接后为 Refresh models（soft）和 Disconnect（danger） | **已确认设计：连接动作继续使用 primary 样式。**保留账号连接状态、Reconnect/Continue 语义和 provider 卡片层级 | 历史 Connect 对象是旧 ChatGPT composer 连接入口，现已移至 Provider 设置；此入口与下方远程 Executor 的 `Connect Executor` 是不同对象。该样式决定已确认，不再列为待定 |
| 通用模态框与表单框架 | 各类表单、确认与设置弹窗；具体内容由不同区域组件提供 | `src/web/styles/shared/modal-form.css:1-130`；晚于它加载的特定弹窗内容在 `src/web/styles/regions/dialog-content.css` | 背景遮罩含 blur；标准 modal 宽度上限 490px、最大高度 90dvh、22px padding、20px 圆角；标题使用 DM Serif Display；表单说明和字段标签字号较小 | 保留默认尺寸、滚动、遮罩、标题字级与表单字段层级，除非设计明确批准更改；输入框基色和边框可评估 token 化 | 特定 modal 是否覆盖宽度、高度或移动端间距，需继续逐一检查调用位置与响应式规则 |
| 侧栏与应用外壳 | 全局应用框架、Project/Thread 列表、导航、窄/标准/宽侧栏 | `src/web/styles/regions/shell-sidebar.css:1`；全局基线在 `src/web/styles/base/document.css` | 侧栏宽度由 shell variant 控制；导航、分组、选中项、计数和底部连接状态各有自身文字/表面层级 | **已有**区域样式文件；保留导航状态、宽度选项、滚动和窄屏行为。颜色变量复用是**待统一** | 需逐状态核对 hover、active、unread、disabled 的对比度，避免把导航行误作普通列表项 |
| 顶部栏、连接与状态通知 | Breadcrumb、Executor pill、Runtime 连接状态、通知/诊断条 | `src/web/styles/regions/topbar-notices.css:1`；对应标记也见 `src/web/App.tsx:3428-3481` | 连接/Executor 状态有 online/offline/warning 状态点与文字；通知和错误内容使用不同色彩、背景与边界 | **已有**区域样式文件；保留状态语义和文字标签，不把状态只表达为颜色。状态 token 复用是**待统一** | 状态胶囊与通知横幅的色彩及 aria/status 输出应逐一核对 |
| 工具栏、Native Tools 和插件 popover | Thread toolbar、计数 badge、Native Tools 菜单、插件贡献弹层 | `src/web/styles/regions/toolbar.css`、`toolbar-controls.css`、`toolbar-panels.css` | 入口按钮、badge、面板标题/说明、工具行和空/错状态各自有尺寸及文字层级；popover 的卡片 padding 有专门 reset | 保留工具行密度、badge 位置、popover 锚定和滚动；表面/边框色可评估 token | toolbar 在窄屏有额外入口和排列规则；不与 modal 合并 |
| 认证与欢迎页 | AuthGate 登录/重连界面；无 Thread 时的欢迎/引导页 | `src/web/styles/regions/auth.css`、`welcome.css`；组件在 `src/web/AuthGate.tsx` 与 `src/web/App.tsx` | 两个页面共享 mark 的视觉元素，但 auth card 与欢迎页标题、说明、动作布局不同；welcome 标题有强调排版 | auth/welcome 样式**已有区域拆分**；保留登录与欢迎的内容层级、表单反馈和动作位置。重复 mark 规则可评估共享 | 卡片宽度、标题字型、背景和动作排列若要统一，属于页面设计变更 |
| 会话/对话区 | Thread timeline、消息、执行步骤、尝试切换、状态/滚动条 | `src/web/styles/regions/conversation.css`、`conversation-events.css`、`reasoning.css` | 内容文本、时间/来源元数据、执行状态、失败提示、滚动条分别处理；Markdown 另有内容规则 | 会话样式**已有区域拆分**；保留消息与工具内容层级、状态提示、滚动行为。muted/状态色的 token 复用是**待统一** | 多个执行状态和历史状态的对比度、窄屏换行需按实际组件核查 |
| Composer 布局与输入区 | Composer 文本输入、发送/停止/运行状态、插件贡献控件与模型选择入口 | `src/web/styles/regions/composer-layout.css`、`composer.css`、`composer-integration.css` | Composer 外壳、focus-within、textarea、状态按钮、插件控件容器和 toolbar popover 各自有布局；运行/权限等待状态有独立类 | Composer 样式**已有区域拆分**；保留输入尺寸、焦点反馈、状态按钮行为和贡献控件滚动。基础边框/焦点 token 复用是**待统一** | Composer 主次控件在桌面与移动端的排序、显示和尺寸不宜仅靠 selector 名称统一 |
| ToolCard 内容与交互 | 工具调用卡片、Readable/Raw 切换、命令/结果/搜索匹配和长内容 | `src/web/styles/regions/tool-card-heading.css` 及 `src/web/styles/regions/tool-card/`；入口 `src/web/tool-card.css` | 标题、错误态、字段名、代码/命令预览、搜索命中、结果面板分别设色、字号、溢出和滚动 | 保留 raw 内容的可读性、等宽字体、长输出滚动/换行和错误区别；共同边框/表面 token 可评估 | ToolCard 同时消费 public plugin CSS，需核对最终级联后再改公用色值 |
| MCP 设置区 | MCP server 列表、编辑表单、安全提示、确认弹层和响应式内容 | `src/web/styles/regions/mcp-settings/`；入口 `src/web/mcp-settings.css` | authorized/warning/error 状态有专门颜色；列表、编辑器、确认对话框及窄屏布局分文件维护 | 保留安全/授权/错误状态的区分、确认动作和窄屏结构；颜色 token 可在语义保持的条件下评估 | MCP 确认对话框是否覆写通用 modal 的尺寸与层级，应继续检查具体覆盖规则 |
| Markdown 消息正文 | Assistant/工具正文中的 Markdown 排版 | `src/web/styles/content/markdown.css` | 标题、段落、列表、链接、代码和引用按文档语义排版，不复用表单/按钮字号系统 | 保留正文层级、代码可读性、链接状态与内容宽度；可核对全局颜色变量的兼容性 | 深浅底、插件内容与错误消息内的 Markdown 对比度需按使用场景核验 |

## 共享单一控件

| 控件 | 使用位置 | 样式来源 | 当前文字、容器与状态特征 | 应保留 / 可归并 | 尚待核查 |
| --- | --- | --- | --- | --- | --- |
| 插件 Select | 插件配置树中的 select；模型参数 `ParameterField` 也复用 `PluginUiSelect` | `src/web/styles/shared/plugin-select.css:8-116`；共享控件和 listbox portal 在 `src/web/plugin-ui-select.tsx` | Trigger 普通高度 36px、compact 32px；菜单 fixed 定位、最高高度由运行时位置决定、最大宽度受视口限制；选项最小高度 32px；有 active/hover、selected、disabled、focus-visible 状态 | 保留 ARIA/listbox、键盘操作、portal、尺寸和状态区别。重复的颜色/边框/圆角可以按当前计算样式抽变量 | 模型 chooser 是独立区域面板，不属于此 Select；注意 `plugin-select.css` 目前也含 `.plugin-ui-range-control` 和 `.plugin-ui-control` 的通用规则，文件名不完全等同于单一控件 |
| 插件、Native 与模型参数 Switch | 插件 UI 树开关、Native Tools/插件管理页及模型参数开关；compact composer contribution 可显示为带边框的紧凑胶囊 | `src/web/styles/shared/switch.css:1-68`；DOM 在 `src/web/plugin-ui-tree.tsx:229-245` | 30×18px 轨道、14px thumb；未选中灰色、选中鼠尾草绿；native、plugin 与模型参数开关共用轨道、选中背景、thumb 和位移；插件 compact 外层另有文字、padding、白底、边框和圆角；plugin 有 focus-visible | 三种开关的基础外观**已经共享**。保留各自类名、DOM、标签、checked/disabled/focus 状态和 compact 外框 | 模型参数保留 checkbox 和焦点轮廓；检查最终效果即可 |
| 插件按钮 | 插件 UI 树中的 action/button | `src/web/styles/shared/plugin-buttons.css:1-40`；调用在 `src/web/plugin-ui-tree.tsx` | 默认最小高度 32px；primary、soft、danger、quiet 变体有不同前景/背景/边框；文字继承上下文 | 保留变体语义及各自颜色状态。确实相同的基础尺寸、边框或焦点规则可整理 | 与产品级 `.button` 不是同一套类名和默认尺寸；统一主次层级需要设计确认 |
| 插件字段与输入标签 | 插件 UI 树中的字段、checkbox/action label 等 | `src/web/styles/shared/plugin-fields.css:1-42`、`plugin-inputs.css`、`plugin-range.css`、`plugin-select.css` | 字段标签默认为 muted、12px；action field 下按钮铺满；checkbox label 有独立对齐与间距 | 保留控件类型及标签辅助信息的结构；相同文字色/字段间距可在核对全部控件后抽取 | 需继续对照输入、表格、disclosure 的实际标注层级和 focus/error 状态 |
| 插件卡片与动作布局 | 插件面板和嵌入式插件贡献 | `src/web/styles/shared/plugin-layouts.css`、`plugin-surfaces.css:1-16` | 卡片有 line 边框、12px 圆角、paper 底色、12px padding；actions 可换行并保持间距 | 保留内容容器的流式布局和溢出处理；颜色/边框 token 可统一 | toolbar popover 会重置卡片外观并重设内部 padding，见多变体表 |
| 插件状态胶囊、表格、列表与 Disclosure | 插件 UI tree 中 status/list/table/disclosure | `src/web/styles/shared/plugin-status.css:1-20`、`plugin-data-disclosure.css:1-44` | status 有 neutral/success/danger；表格支持横向滚动、表头层级、单元格分隔；Disclosure summary 使用 sage-dark；unavailable/loading 为 muted 文字状态 | 各控件的**共享单一控件规则已存在**；保留状态语义、数据滚动和表格结构。跨区域状态 token 复用是**待统一** | 真实插件数据、窄屏表格和各 surface 下的状态对比尚需核对 |
| Checkbox 与 Range | 插件 UI tree 中 checkbox、range/value | checkbox label 在 `src/web/styles/shared/plugin-fields.css:35-42`；range 在 `src/web/styles/shared/plugin-range.css:1-16`，range control 在 `plugin-select.css:1-7` | Checkbox label 使用 muted 文字和独立 gap/最小高度；Range label/value 使用 muted/ink、12px/10px 字号，range control 铺满可用宽度并使用 accent-color | 单控件样式**已有**；保留 checkbox 与 switch 的语义差别、range 原生操作和值布局；相同文字色可候选复用 | `.plugin-ui-range-control` 仍位于 `plugin-select.css`；若后续仅做文件归类，需保持 CSS 导入级联 |

## 多变体

| 变体组 | 使用位置 | 样式来源 | 当前差别与状态 | 应保留 / 可归并 | 尚待核查 |
| --- | --- | --- | --- | --- | --- |
| 产品按钮 vs 插件按钮 | 产品表单/工具栏动作；插件 contribution action | 产品 `.button`：`src/web/styles/shared/buttons.css:1-57`；插件 `.plugin-ui-button`：`src/web/styles/shared/plugin-buttons.css:1-40` | 产品默认 34px 高、10px 圆角、11px/600 字重；primary 有渐变和阴影。插件默认 32px 高、9px 圆角；按 primary/soft/danger/quiet 区分 | 保留各自尺寸和层级表达；可在视觉核验后共享基础颜色 token 或 focus 样式 | 迁移产品按钮与插件按钮之间的动作属于语义/视觉变化，应由设计确定；历史 ChatGPT composer Connect 已迁至 Provider 设置，见下文 |
| Native tool Switch 与插件 Switch | Native Tools popover/插件管理列表中的原生开关；插件 UI 树 Switch | 两者轨道和 thumb 规则现已并列于 `src/web/styles/shared/switch.css:22-68`；插件管理列表行对齐见 `src/web/styles/regions/settings.css:289-302` | `.native-tool-switch` 与 `.plugin-ui-switch-control` 共用轨道/选中背景/thumb/位移；插件 Switch 保留 disabled/focus-visible；三者共享滑块阴影 | **已实现共享基线**；保留类名、DOM、标签、disabled/focus 行为和区域布局 | 不再属于待统一项；只需核对各自背景下的最终对比度 |
| Select 菜单 vs 模型 chooser vs More 面板 | 插件 Select listbox；Composer 模型/Adapter chooser；More 参数面板 | Select：`shared/plugin-select.css:70-116`；模型和 More：`regions/model-selection.css:87-248` | Select 是选项列表，固定 portal 并有 active/selected 标记；模型 chooser 是双列 `role=dialog`；More 是参数组 `role=group` 并定位于 composer 附近。圆角/背景/阴影略有差异 | 保留 role、位置策略、宽度/高度和键盘/关闭行为；表面色/边框可候选 token 化 | 三者是不同组件与交互；禁止仅为视觉统一而重用相同弹层结构 |
| Toolbar plugin popover vs 通用 modal | 工具栏插件弹出面板；中心模态表单 | `src/web/styles/regions/toolbar-panels.css:1-37`；`src/web/styles/shared/modal-form.css:1-24` | Toolbar popover 为 fixed、z-index 20、最大宽度受视口约束，内部重置 plugin card；Modal backdrop 使用 z-index 30、全屏遮罩与 blur，modal 居中、有 max-height 和滚动 | 保留定位、遮罩语义、z-index、内容滚动和内部 padding；可评估统一表面色、边框色或阴影 token | 宽度、模糊、阴影强度、圆角和遮罩透明度变化需设计确认 |
| 产品状态/胶囊与插件状态胶囊 | Topbar/Settings/工具区域状态；插件 UI 的 status | `src/web/styles/regions/topbar-notices.css`、`settings.css`、`toolbar-controls.css`；插件状态在 `src/web/styles/shared/plugin-status.css:1-20` | 状态名、背景、边框和字号按 Runtime、Executor、plugin 等上下文定义；状态语义并不完全相同 | **现状**：各区分别定义状态表现，插件已有 status 变体。**待统一**：同语义颜色 token；保留各上下文状态词和 success/warning/danger/unknown 映射 | 不按颜色相似度合并状态；核对 aria 文本、状态来源及高对比背景 |
| 通用表单 surface vs Executor 连接卡片 vs plugin card | Modal 输入和表单；远程连接详情；插件内容卡 | `shared/modal-form.css:60-96`；`regions/dialog-content.css:55-74`；`shared/plugin-surfaces.css:1-9` | 输入为白底、9px 圆角、固定边框色；Executor 卡片灰白底、14px 圆角；plugin card 使用 paper 与 12px 圆角/12px padding | 保留信息密度、卡片间隔和正文/输入层级；基础 surface/border tokens 可逐项比较后归并 | 连接项、插件卡与字段框不能因同属“容器”就变为同一种背景、圆角或内边距 |

## 历史文案与当前对象映射

- 历史 `ModelParameterOthers` 对应当前模型参数展开入口 `More`；More 当前承载额外模型参数。源码布局和参数映射见 `src/web/model-selection.tsx:480-482,550-619`，样式见 `src/web/styles/regions/model-selection.css:87-128`。已确认 More 保持控件式按钮样式。
- 历史 ChatGPT composer `Connect` 连接入口现已移至 Provider 设置；当前 Provider 设置挂载在 `src/web/App.tsx:4751`，容器由 `src/web/provider-settings.tsx:40-120` 提供，ChatGPT 插件的 Continue/Reconnect primary 操作见 `src/plugins/chatgpt-plan/webui-entry.tsx:336-359`。已确认该连接动作保持 primary 样式。
- 当前 New Thread 的 `Connect Executor`（`src/web/App.tsx:5254-5255`）是独立的远程 Executor 连接动作，与历史 ChatGPT composer `Connect` 不同；不要将两者的样式、页面归属或文案合并。
- 上述已确认对象映射不授权改动文案、显隐、分组或页面结构；若要改这些产品行为，需另行确认设计。

## 阶段 1 建议边界

1. 优先做视觉等价整理；已确认要统一的模型参数开关和 More 弹层外壳有少量视觉变化。保留 DOM、定位和交互。
2. 将多个相似但不相同的控件继续作为独立变体；设计确认前不改按钮主次、字段密度、弹层宽度/位置、标题字体或状态色语义。
3. 历史 `ModelParameterOthers` → 当前控件式 `More`、历史 ChatGPT composer `Connect` → 当前 Provider 设置 primary action 的映射和样式决定均已确认；仍须把远程 `Connect Executor` 作为独立对象记录，不能据相同词形合并。

全局入口 `src/web/styles.css:1-36` 的顺序会影响后加载区域规则对 shared 样式的覆盖。任何整理应保留该顺序，直到独立核验 cascade 后再评估调整。
