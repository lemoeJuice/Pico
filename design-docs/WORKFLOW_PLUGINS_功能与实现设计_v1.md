# Workflow Plugins 功能与实现设计

状态：用户已确认并开始实现；接口以 Runtime 契约和阶段验收为准。

本文补充 [Agent Harness 核心架构与设计意图记录 v5](Agent_Harness_核心架构与设计意图记录_v5.md)，落实当前阶段的七项 Workflow Plugin 和 Usage 统计设计。实现仍受现有架构锚点约束：Thread 是长期工作单元，Canonical History 只追加，Projection 决定模型输入，插件状态按命名空间持久化，Executor 不承载 Harness 工作流语义。

## 1. 当前阶段范围

| 序号 | 插件 | 主要职责 | 当前基础 |
| --- | --- | --- | --- |
| 1 | Permission | 在单个 Tool Invocation 边界授权；支持 reviewer 自动审批模式 | pico.permissions 已存在，支持 allow / deny / ask 与审批 UI |
| 2 | Goal | 用户提供持续目标；Agent 在同一 Thread 中持续推进，直到完成、暂停或需要用户输入 | 未实现；Runtime 缺少插件驱动的持久续跑条件 |
| 3 | Todo | 管理短期清单；由 Agent 按需创建并在完成后勾选 | 未实现 |
| 4 | Rolling Context | 管理同一 Thread 的 hot / warm / cold 上下文；复用 Runtime 的手动 fallback compact | 分层面板已实现；`/compact` 由 Runtime 核心提供，不依赖本插件 |
| 5 | Project Context | 自动维护 Project 级共享记忆并注入相关内容 | pico.project-context 目前仅支持手动设置与清除 |
| 6 | Global Memory | 跨 Project 的长期用户偏好与知识；由 Agent 判断是否记入 | 未实现 |
| 7 | Subagent | 通过普通 Child Thread 和 Message 提供非阻塞、双向协作 | pico.collaboration 已提供基本 spawn / send 工具 |
| 8 | Usage | 聚合主模型、插件辅助模型、重试和缓存相关用量 | 目前有单次 Model Step token 展示，缺少统一的插件用途和成本归集 |

Project Context 与 Global Memory 是两个有不同作用域的插件能力，可以共享记忆条目的数据约定和管理界面，但不能把项目知识自动提升为跨项目事实。

## 2. 共同边界与 Runtime 扩展

### 2.1 事实、状态与 Projection

- Canonical History 保存已经发生的 Message、完整 Model Step、Tool Call / Result 以及插件审计事件；已提交记录不可修改或删除。
- 每个插件自己的当前状态保存在 Plugin State。可重建的进度游标、Goal 状态、Todo、记忆索引、Rolling Context 分层都属于可变状态。
- 插件的审计事件采用插件命名空间追加到 Canonical History；Projection 只消费 Canonical Records 与插件状态，不回写历史。
- Goal、开放 Todo、相关 Project / Global Memory 与 Rolling Context 都会影响模型输入。Goal 与 Todo 分别以带来源标识的 Projection turn/message 注入模型上下文，不只是 UI 状态；这些合成 turn 不伪装成已提交的 Canonical User Message。最终发送给 provider 的 prompt 必须来自 Runtime 记录的实际 Model Input，而不是 UI 事后拼出的近似版本。

### 2.2 已有 Tool Batch 语义

一次 Model Step 可以返回多个 Tool Call；Runtime 默认并发运行这些调用，并等待整个 Batch 到达安全边界后再做下一次 Model Step。因此插件 Tool 必须能安全面对并发调用：状态变更使用原子事务、稳定调用 ID 和幂等更新；同一个 Batch 内的调用不得隐含先后依赖。Batch 不是事务，不会在一项失败时回滚其他副作用。

### 2.3 Goal 需要的持久续跑契约

当前 Runtime 在没有新用户消息、待处理 Tool Batch 或模型重试时会结束该 Thread 的 loop。即使 Goal Plugin 状态仍是 active，单靠现有 step interceptor 也无法要求 Runtime 在普通 Assistant 最终文本之后继续一次 Model Step。

增加一个通用、插件持有状态的 continuation 契约：

1. Workflow Plugin 可以登记一个只读的待办判定，例如 hasPendingWork(threadId)；判定依据只能来自其持久化状态。
2. Runtime 的 needsModelStep、Thread 启动和重启恢复都纳入该判定。Goal 置为 active 且本轮需要继续时，Runtime 在当前安全边界之后继续同一 Thread 的 loop。重启后重新读取持久判定；若 Thread 仍处于 Pause，则等待用户 Continue，不自动越过 Pause。
3. continuation 不创建 Run、Intent、Task 或 Process Manager 对象；Thread 仍只有一条 active agent loop。
4. 用户 Pause、Interrupt、未完成 Tool Execution、Permission 等待、provider/context 错误优先于插件 continuation。Goal 不得自行解除这些状态。
5. 每次推进仍经过常规 Projection、Model、Tool Batch 和 Tool Invocation Pipeline；模型输出仍使用普通 Canonical History 语义。
6. 每轮消费/更新续跑状态必须幂等。Runtime 重启时按已持久化状态恢复，不依赖内存 waiter。
7. 防止模型空转：记录连续无进展步数和本次 active 推进预算；达到上限就暂停 Goal 并说明原因，保留用户 Continue / 编辑目标入口。

当前 Pipeline 的 step 边界可以包裹一整次 Model Step 和其 Tool Batch，但它本身不构成“有待办就启动 Thread”的 durable work source。Continuation 应由 Runtime 提供稳定的通用插件服务，不应由 Goal 私自修改 Runtime 内部 loop 函数。

### 2.4 插件辅助模型调用与可观测性

Rolling Context 需要调用 LLM 为每段生成摘要并独立评估分层；Permission 的 reviewer 也可能需要单独模型调用。现有 Plugin Services 没有模型调用入口，故新增受 Runtime 管理的辅助模型服务，设计语义如下：

- 输入包含用途（例如 rolling-summary、rolling-tier-review、permission-review）、模型配置、结构化请求、取消信号和幂等键；密钥继续由 Runtime Provider Adapter 管理。
- 每次辅助调用有独立的稳定执行/请求 ID、Provider 尝试追踪、prompt 记录、token 用量、失败与取消结果，并可按 Thread / Project / 全局用途归集。
- 返回结构化结果给调用插件；默认不写普通 Assistant Message、不启动 Tool Batch、不直接改变 Goal 状态。
- 遵从 Thread Pause / shutdown / abort；服务不可用或超时时由发起插件按自己的安全失败策略处理。
- 辅助调用模型可单独配置；默认沿用可用的 Thread Model Profile，且不因调用辅助服务而扩大该 Thread 的权限。

现有 Model Input execution log 已记录经过 projection 和 model plugins 后传给 Adapter 的 prompt。扩展 UI 应读取这份记录，展示真正发送内容和每次 Provider Attempt，而不能从 Canonical History 重构一个“看起来相同”的版本。

### 2.5 插件控制面板、动态入口与热重载

- Pico 内建插件控制面板，列出已安装插件、版本、来源、启用状态、加载状态、加载错误和插件页面入口；支持启用、停用和显式重新加载。
- 用户的启停选择持久化。核心基础能力和控制面板自身不可停用；其他插件可独立启停。外部插件入口仍由 PluginHost 契约验证，UI 继续使用隔离 iframe 和已注册静态 API。
- Runtime 插件以 `plugins/<plugin-id>.mjs` 独立入口加载，插件 UI、元数据和资源放在 `plugins/<plugin-id>/`。各插件运行时代码单独打包到各自入口，不静态 import 到 Pico Runtime 或 Web UI 主 bundle。
- 首选无重启热重载：停用时先确认相关 Thread 没有正在执行的 Model / Tool Execution，随后调用 deactivate、清理该插件注册的 Tool、Pipeline、Command、Route、Provider 和 UI Contribution，再重新导入带新版本 URL 的入口并 activate。启用、停用或重载期间发生错误时保留诊断；重新启用失败不能留下半套注册。
- 目录变化可由 watcher 或控制面板显式 Reload 触发。若运行时无法安全替换（例如有执行仍在进行、平台不支持动态导入或插件包无效），保留当前有效版本并在面板中说明需等安全边界或重启；不得为刷新插件而重启整个应用。
- 插件启停不改写 Canonical History / Plugin State。重载期间保留各插件自己的持久状态；初始化和替换必须幂等。

## 3. 各插件设计

### 3.1 Permission：独立 Reviewer 的 Auto 模式

**目标与边界**

Permission 在每次 Tool Invocation 执行前作单次授权，覆盖 Runtime Tool 与 Executor Tool。现有 allow / deny / ask 规则继续有效；Auto 模式只把本来需要等待人的 ask 请求交由独立 reviewer 判断。它是 reviewer 替换，不是授予主 Agent 更大权限。

**决策流程**

1. 先应用已经配置的静态拒绝、允许和要求询问的规则。
2. 对 ask 请求，若 Thread 当前选择 Auto-review，构造一个最小 reviewer 输入：本次 Tool 名称和完整参数、有效的权限 / sandbox 边界、必要的相关 Canonical Message 和 Tool 证据。
3. Reviewer 返回结构化 allow / deny 与简明理由。Reviewer 不得改写参数、不运行该 Tool、不生成可复用的新权限规则。
4. Reviewer allow 只授权这一个确定的 invocation / execution ID，调用仍受原 Sandbox、可写路径、网络和 Tool allowlist 约束。
5. Reviewer deny 将明确原因作为 Tool 结果返回 Agent，并要求停止相同目的的规避尝试；Agent 可选择实质上更安全的路径，否则说明被阻止。
6. Reviewer 超时、格式无效、模型不可用或上下文不足时 fail closed：维持等待人工审批或按显式配置拒绝，不能把错误当作 allow。

**状态与界面**

- 配置区分“规则要求 ask”和“ask 由谁裁决”：用户或 Auto-review。已有规则优先级不变。
- 审批记录包含调用 ID、Reviewer 模型/版本、结果、理由、时间和是否最终执行；不保存隐藏推理。
- UI 展示等待中的请求、Auto-review 结果及理由、实际执行结果；用户仍可对一个精确拒绝请求做一次性覆盖，不能借此更改其他调用的长期规则。
- 每轮维护 reviewer 连续拒绝和总拒绝熔断器，触发后暂停该轮并显示原因，避免主 Agent 在循环里反复尝试越界动作。

**失败与不变量**

Auto-review 只审查已经触达 Permission 边界的请求；日常已在沙箱内允许的调用不必额外审查。它不得扩大权限、切换 sandbox、覆盖受管理策略或把一次 allow 持久成通配规则。对高风险、越界、含秘密外传或不明确的动作应拒绝或交还人工。

### 3.2 Goal：用户提供的持续迭代目标

**目标与边界**

Goal 是同一 Thread 的持续工作目标，由用户明确提供，包括结果、约束和可验证完成标准。它决定模型在每一轮应推进什么，并提供持久 continuation；它不是 Todo 的替代品，也不是新建独立 Run。用户可暂停、恢复、编辑或清除。

**生命周期与推进**

- 状态建议为 active、paused、needs_input、completed、cleared。每次状态变化追加 Goal 插件审计记录。
- 只有用户创建、编辑或清除目标。启动时把用户给定目标及完成标准写入 Plugin State，并将目标作为普通用户 Message 进入首轮上下文；若目标本身已由当前用户 Message 提供，不重复追加。Goal 投影在之后每个 Model Step 中保持可见。
- Agent 在每轮之后根据 Goal 判断下一步：若仍有可执行工作，保持 pending continuation；若被外部条件阻塞，调用 Goal 工具暂停并给出需要的输入；若满足用户标准，必须提供验证依据后才能将 Goal 标为 completed。
- Agent Tool 只能更新进度、登记阻塞、暂停续跑或提交完成请求；完成请求须引用已经结束的验证 Execution / Canonical 证据，且验证不能与完成请求处于同一并发 Tool Batch。用户通过 UI 或命令暂停、恢复、编辑或清除目标。Agent 可以建议修改，但不能自行改变用户目标、约束或验收条件。
- Goal 进入 completed、paused、needs_input 或 cleared 后清除自动续跑请求。若同一批 Tool 尚未完成，Runtime 仍照常等待 Batch 安全边界。
- 暂停后收到新消息只追加上下文；是否继续由用户 Continue 或编辑后的 Goal 决定。

**上下文与 UI**

- Projection 注入当前 Goal、约束、完成标准、最近进度和当前阻塞点；完成标准应保持原文可追溯。
- Goal 进度栏显示状态、最近进展、当前动作、最近验证和 Pause / Resume / Edit / Clear 控件。手机屏幕也可执行上述操作。
- 通用通知只陈述 Goal 状态，不自动创建新 Thread 或外部定时任务。

**护栏**

不按累计模型轮数自动暂停 Goal。Agent 可通过明确的 needs_input / paused checkpoint 报告阻塞，用户也可主动暂停；继续时沿用原 Thread 和已持久化 Canonical History。Permission、Executor 和 provider 限制仍独立有效；Goal 活跃不等于获得审批或更宽沙箱。

**Harness 参考与取舍**

Codex 的 Goal 模式把目标文本用作首条 prompt 和完成标准，允许在同一个 Thread 暂停、恢复、编辑和清除；它同时保持原 sandbox 和 approval policy。此设计沿用这些用户可控生命周期和同 Thread 持续性的做法，结合 Pico 的 append-only History 和普通 Message 模型，不引入 Goal Run。LangGraph 等 Harness 的 durable graph/checkpoint、interrupt/resume 与有界循环说明，续跑必须依赖持久状态、可恢复安全边界和显式迭代上限；Pico 采用通用 Plugin continuation、Runtime 安全边界与进展熔断，不照搬图执行对象模型。

### 3.3 Todo：短期待办清单

**目标与边界**

Todo 是 Agent 可选的短期待办列表。收到用户消息后，Agent 自行判断这段工作是否值得拆解；没有必要时无需创建清单。Todo 不负责继续模型循环，也不等同于用户提供的长期 Goal。

**状态与工具**

- 每条项目至少包含稳定 ID、标题、状态 open / done、创建来源、创建时间、完成时间及可选 source Message / Tool refs。
- Tool 面向 Agent 提供 list / add / update / complete；对相同稳定调用 ID 重试时不得重复插入。
- Agent 完成事项后应主动勾选完成。部分完成保持 open 并更新明确下一动作，不要通过删除来掩盖状态。
- 每次更新使用单个原子状态事务；同批并发 Tool 更新采用版本检查或按 ID 合并，避免整张清单最后写入者覆盖。

**上下文与 UI**

- 每次 Model Input 投影当前 Thread 的开放 Todo（数量较多时按活动和优先级裁剪）；已完成项保留于 UI / Canonical 审计记录，默认不占后续 prompt。
- UI 在 Thread 侧栏/工具栏查看和手动修改；Agent 自动更新不要求逐项人工确认。支持从条目跳回来源 Message。
- Todo 作为 Goal 的执行细节可以关联 Goal ID，但 Todo 也可独立存在；所有 open Todo 完成不自动代表 Goal 完成。

### 3.4 Rolling Context：hot / warm / cold 与 fallback compaction

**目标与数据源**

Rolling Context 以 Canonical History 为唯一历史依据，并在自己的 Plugin State 中维护分段、分层和摘要。Canonical 内容始终完整保留。Rolling Context 只改变 Projection：

- hot：将该段原始 Canonical 内容放入实际 Model Input。
- warm：用该段已保存的直接摘要替代其原文。
- cold：该段及其摘要都不进入实际 Projection，仅保留源记录引用、hash、摘要和转层审计供管理与召回。

分段必须覆盖完整、已提交的上下文范围；边界不得落在未完成 Model Step、Tool Call 与对应结果之间或仍有副作用不确定性的 Execution 中。Segmenter 在完整 Canonical turn block 之间封段；每个 block 包含其用户/Child Message、Assistant 调用链及对应 Tool Results。可合并相邻完整 block 到目标 token 窗口，但不得拆开一个 Tool Call / Result 对。每个封段单独总结，不把相邻段合并成一次整段对话总结。只有批次全部到达 Terminal State 后才能封段。活跃段和未完成 execution 保持 hot。

**每段独立直接总结**

1. 每个安全封段后，Rolling Context Plugin 调用 Runtime 辅助模型服务，针对该段的 Canonical 原文单独生成摘要。摘要不递归概括之前摘要；每段保留自己的原文引用、source hash、摘要 prompt / model / version、输入输出 token 与调用状态。
2. 摘要应保留目标和约束、已验证事实、关键决定及其理由、未解决问题、失败/风险、Tool 结果出处和后续动作。无关重复可以压缩；不能把推断写成已验证事实。
3. 摘要失败时，段保持 hot，记录失败，后台可在后续安全边界重试；不以截断原文或空摘要代替。
4. 摘要生成后先做费用预估。只有段级输入 token 节省、缓存前缀影响、预计未来复用次数以及摘要和 Reviewer 调用成本都可估算，且严格净节省为正时，才调用独立、无 Tool 权限的 Rolling Evaluator Agent。缺少任何一项或净节省不为正时，记录 `skipped` 原因、保持 hot，并且不产生 Reviewer 调用。Evaluator 获得费用预估和该段原文、现有目标与近期上下文，返回结构化建议、信心和简要理由；它不写摘要、不直接改变 Canonical History。
5. 只有费用预估仍为正、语义风险可接受且 Reviewer 建议适合的目标层级时，插件才执行自动转层。成本资料未知或不完整时，始终保持 hot；用户显式手动 compact 仍可绕过自动收益门槛。

**成本与 provider cache**

成本节省是自动 warm/cold 的门槛，不是假设。收益预测按 token / provider 实际计量和未来预计请求次数计算，不能用字数比例替代。缓存命中、缓存写入、缓存 TTL、不同输入 token 价格如果 provider 未公开或运行时没有可靠报告，系统必须把该数据标为 unknown；严格自动模式下既不得调用 Reviewer，也不得自动转层。UI 的手动 compact 可在成本未知时由用户明确触发。

当前实现状态：Runtime 尚未提供完整净节省估算能力。因此每个新段完成摘要后都会将 tier review 标为 `skipped`，即使已在 Usage 配置费率也不会调用 Reviewer 或自动 warm/cold；费率只是估算成本所需输入之一。上面的条件描述的是完整估算能力接入后的目标行为。

Projection 顺序与摘要必须稳定，不能为了短 prompt 每轮随机重排内容。变更早期段落可能破坏其后的 prefix cache，因此 evaluator 应把预计 cache miss / 前缀失效成本计入。已 warm 摘要保持稳定，不因每轮新语境重新改写；若确需重算，先记录新版本和差异，并在安全边界原子替换。

**warm 到 cold 与召回**

- warm 段在后续 Goal 变化、较长新活动或未来窗口评估时可再次接受分层评估。
- 只有在预计未来上下文不再需要该摘要、相关性低、且源 Canonical 引用可恢复时，才从 warm 转 cold。
- cold 从 Projection 移除摘要；记录 tier transition、原因和被移除的精确 summary version。
- Agent 被用户要求回顾某段旧事时，提供按段/关键词召回工具，从 Canonical source 读取证据；被召回内容在当前请求中短暂加入 Projection，默认不永久改写历史层级。用户可以 Pin 回 hot。
- 自动层级决策不删除原文，也不允许只靠摘要覆盖的旧状态更改未经验证地渗入记忆插件。

**fallback compaction**

`/compact` 是 Runtime 核心命令，Rolling Context 未安装或停用时仍可使用。它只对已完成的完整 turn block 总结，保留最近两个完整 turn 原文；单次输入超过 60,000 字符时按安全边界缩小范围，若最老的候选 block 单独超限则不修改状态。摘要最多 12,000 字符。

- Runtime 使用当前 Thread 选择的 Provider 和既有 model stage，生成无 Tool 的辅助摘要；不新建 agent loop、Execution、普通 Assistant Message 或 Tool Batch。
- 成功后向该 Thread 的 Canonical History 追加带版本、throughSeq、source IDs/hash 和摘要的 Runtime compaction fact。原始 Message、Assistant 与 Tool Result 永不修改或删除；模型请求失败或摘要无效时不追加 compact fact。
- 后续唯一主执行路径从 Canonical History 重建 Projection：验证 compact fact 覆盖的 source IDs，使用摘要替换此前缀，再接入后续原始 turn。重启不依赖 Plugin State 或 Rolling Context 状态。
- Rolling Context Panel 仍可操作自己的 warm/cold 分层与 segment summary；这些可选功能不会拥有 `/compact` 命令，也不会覆盖 Runtime compaction 已替换的前缀。
- Provider context limit 可使 Thread 暂停；用户可调整 Thread 模型、调用 `/compact`、查看实际 Model Input，再 Continue。

**观测 UI**

单独提供 Rolling Context Panel，按时间列出每段 tier、Canonical seq / Message 引用、源文本、摘要、摘要版本、Evaluator 判断与理由、预计成本、实际摘要/evaluator 开销及历史转层。用户可以 pin hot、手动 warm / cold、重试摘要和召回 cold 段；跨插件关闭仍可用的长会话压缩由 Runtime `/compact` 提供。

每次主模型调用提供“实际 Model Input”视图：逐字展示最终传给 Model Adapter 的 system prompt、turns、tools 与 projection boundary；对每段标明原文、摘要替换、cold omission、Goal/Todo/Memory 注入来源以及 provider attempt。它应读取执行日志中记录的真实 prompt，精确保留换行和调用参数；凭证不进入记录。UI 同时解释每个 Canonical 区间为什么出现在或没出现在本次请求中。

### 3.5 Project Context：自动 Project 记忆

**目标与边界**

Project Context 是本 Project 多个 Thread 共享的事实、决策和近期活动；它不复制完整对话，也不自动扩散到 Global Memory。保留现有 /project-context set / clear 手动操作作为迁移与显式修正入口，逐步由 Agent 自动维护取代“用户必须手写全部上下文”。

**自动写入**

- Agent 在重要决策、验证结果、约束变化、开放风险或明显里程碑之后，自行判断是否调用 Project Memory 工具记录；日常闲聊与一次性细节通常不写。
- 写入携带来源 Thread / Canonical seq、类别 fact / decision / activity / open-issue、创建/更新时间、置信状态、有效期或 supersedes refs。
- 归纳不确定时不写成事实；冲突条目以新条目 supersede 旧条目，保留来源和冲突状态，而不是悄悄覆写证据。
- 插件使用 scope 为当前 Project 的名字空间。没有 Project 的 Thread 可以不使用此插件。

**投影与管理**

- Projection 只注入与当前 Thread / Goal / 当前任务相关的小批记忆，并显示每条的来源和有效状态；最近 Project Activity 与稳定 Facts 分区。
- Project Memory 管理页支持浏览、搜索、来源跳转、编辑、删除、Pin、手动记入、纠错和标记过期。Agent 自动写入默认直接生效，不建立强制人工审批队列。
- 目前手动 Project Context 纯文本应迁移成保留原始来源的 legacy/manual entry；迁移后不再强制整块全文注入，应受相关性和预算控制。

### 3.6 Global Memory：自动长期记忆

**目标与边界**

Global Memory 记录跨 Project 仍适用的用户偏好、长期事实和通用协作约定。项目架构、未公开项目细节、Thread 临时状态保留在 Project Context / Thread，不得仅因短期有用而提升为全局记忆。

**自动写入与检索**

- Agent 在出现稳定偏好、跨项目约束、用户明确要求“记住”、或多次重复验证的事实时，自行判断是否调用 Memory 工具；不要求用户先选分类或确认每条。
- 工具支持搜索、写入、更新/替代、删除和 source reference。自动记忆只保存可以由本次会话证据支持的内容；对于不确定、敏感凭证或用户明确要求不记的内容不写入。
- 条目带 global scope、来源 Thread / seq、更新时间、置信度、适用范围和被替代关系。对相互冲突的长期偏好保留出处并在需要时请用户澄清，不自动选择有重大影响的解释。
- Projection 按当前用户请求检索少量相关条目，不把整库记忆附加到每次 prompt。记忆检索结果标明来源和 scope。

**手动管理**

提供统一 Memory UI 的 Global 与 Project 两个 scope。用户可以直接添加、编辑、删除、Pin、搜索、检查来源和调整自动记忆开关；编辑/删除形成可追溯的状态变化。UI 是治理与纠错入口，不是记忆写入的必经审批点。

> 实施边界更新（2026-10-21）：本段保留为原始设计记录。当前界面按作用域分开：Settings 的 Memory 页面只管理 Global Memory；Project Memory 仅从当前 Thread toolbar 打开，不提供统一的 Global/Project scope 页面。

### 3.7 Subagent：Child Thread 协作

**目标与边界**

Subagent 继续使用普通 Child Thread + Message。Spawn 立即返回 Child Thread ID，父 Thread 和子 Thread 各自只有一条 loop，可并发推进并双向发送消息；没有同步函数式等待、Run join、专用 Task 或 SubagentResult。

**实现职责**

- pico.collaboration 负责 spawn / send 工具和协作提示；Runtime 的 Thread / Message API 负责实际创建、投递和恢复。
- Child 默认与父 Thread 同 Project、记录 parent metadata，并绑定创建时选定的 Executor；不可在运行中切换 Executor。
- Child 创建须具有稳定幂等键，建议由稳定 Tool Call ID 派生，避免网络重试重复创建。Message send 使用稳定 message ID。
- Agent 需要结果时读取 Child Thread 普通历史/状态，并通过普通 Message 追问；父 Thread 接收子消息后按 Thread 状态排队或唤醒，paused Thread 仍需用户 Continue。
- 一个 Tool Batch 中多个 spawn 可以并发，但依赖关系要由 Agent 分步发起，不能假定批次内顺序。

**UI**

Thread UI 展示 Parent / Child 关系、child Executor、最近活动和运行状态；可直接打开 Thread、继续发送消息或 Pause。跨环境文件共享、patch/branch 回传不属于本阶段，先通过已有工具和 Message 传递可审阅证据。

### 3.8 Usage：Token、缓存和成本统计

**指标与归属**

Usage Plugin 汇总主 Model Step 与插件辅助模型调用，按 Thread、Project、Provider / Model、用途和时间范围查看：

- input / output / total tokens；
- provider 提供时的 cache read / write tokens、reasoning tokens 和其他计费维度；
- model、summary、rolling evaluator、permission reviewer 等用途；
- provider attempt 的成功、失败、重试、取消与主 Canonical Model Step 的区别；
- 可用时基于生效日期费率的成本估算，无法核实费率或缓存计费时显示 unknown，而不伪装精确金额。

**数据边界**

- 已提交主模型结果与对应 usage 以 Canonical assistant payload 为对话事实；失败、重试和 provider attempt 计量从 Runtime execution telemetry 读取。
- Plugin 辅助调用通过统一的 model service telemetry 进入相同统计面，不能由调用插件重复累加。
- 以稳定执行/attempt ID 去重；并列展示“已完成主调用”“失败/重试尝试”和“插件辅助开销”，不把重试 tokens 误记成成功回复 usage。
- 费率配置属于明确的数据来源，包含 Provider / Model / 币种 / 生效时间；管理员可更新费率，历史统计依照当时的费率快照重算或标注版本。

**界面**

保留当前单次 Model Step 的 token 明细，增加 Thread / Project / 全局聚合面板；每个主调用可以跳到实际 Model Input 和 provider attempt；Rolling Context 页面能单独查看摘要与评估成本，并对比预估节省和观察到的缓存命中变化。

## 4. 默认 Projection 与执行顺序

以下是建议的可检查顺序，实际必须由插件 manifest / Runtime 注册配置明确，不能依赖偶然加载顺序：

1. 从 Canonical History 建立基础 turns 与 system prompt。
2. Rolling Context 按当前 tier 保留 hot、以段摘要替换 warm、移除 cold。
3. 注入当前 Goal 和开放 Todo。
4. 查找与本轮相关的 Project Context 与 Global Memory，并注入有来源标识的短上下文。
5. Permission 根据有效规则过滤不可用的 Tool schema；动态 ask 仍在单次 Invocation 阶段处理。
6. Model Stage 与其他只读/路由插件完成最终处理后，Runtime 记录精确 Model Input 并提交 Adapter 请求。
7. Usage 消费 Canonical 和 Runtime 统一 telemetry，不能再改写 prompt。

工具和辅助模型请求沿各自的调用管线执行。Reviewer 不能在 Permission 决定之前运行原 Tool；Rolling Evaluator 不能越过摘要调用与持久摘要结果直接改层级。

## 5. 与当前实现的差距

仓库当前已支持 Tool Batch 并发、完整 Batch safe boundary、namespaced Plugin State / Canonical Records、插件 UI / commands / toolInvocation Permission Gate，以及从执行日志读取真实 Model Input。已存在 Permission、Project Context 和 Collaboration 基础插件。

上述判断对应的主要代码锚点：Runtime 的 Thread loop 和 Model Step 判定在 src/runtime/runtime.ts（driveThread、needsModelStep）；Projection 输入结构在 src/runtime/stages.ts；OpenAI-compatible Adapter 的并发 Tool Call 请求在 src/runtime/model.ts；插件服务边界在 src/plugins/services.ts；实际 Model Input 展示与按需读取在 src/web/App.tsx 和 README.md。实现阶段应以当时源码为准复核行号与接口。

本设计需要实现前补充的 Runtime 能力：

1. 持久的 plugin continuation 查询、启动和重启恢复，用于 Goal loop。
2. 受 Runtime 控制且可追踪/计量的插件辅助模型调用，用于 Auto-review、摘要与 Evaluator。
3. 插件可访问的统一 Model Attempt / Usage / cache telemetry 查询与事件。
4. Rolling Context UI 的实际 Projection provenance：每个 prompt segment 指向来源记录、摘要版本、被排除原因，并与真实 Model Input 关联。
5. 记忆管理与 Rolling Context 管理的正式 UI semantic slot / API，不直接依赖 App 内部组件。

若 Provider 未提供可信缓存与成本维度，只能提供 token 统计并将 auto-warm 标记为不可判定；不能承诺跨 Provider 恒定、精确的节省金额。

## 6. 确认后的实现拆分建议

用户确认本设计后再进入实现。推荐先确定并实现 Runtime 公共契约，再将无共享文件依赖的插件工作并行化：

| 阶段 | 工作包 | 依赖 |
| --- | --- | --- |
| A | continuation、辅助模型服务、统一 telemetry 与 projection provenance 契约 | 本设计确认；先落公共接口和迁移策略 |
| B | Permission reviewer-auto 与审批 UI | 辅助模型调用、Permission 基础 |
| C | Goal + Todo + Goal progress UI | continuation；Todo 与 Goal 状态需共同约定 |
| D | Rolling Context、摘要/Evaluator、fallback compact 与观测 UI | 辅助模型服务、telemetry、projection provenance |
| E | Project Context + Global Memory 自动写入/检索与管理 UI | 记忆状态/API；可与 B/C/D 并行 |
| F | Usage 聚合 UI 与成本归因 | 统一 telemetry |
| G | Subagent 创建幂等性和状态 UI 完善 | Collaboration 基础；可独立推进 |

不能让各工作包各自发明 continuation、辅助 Provider 调用或缓存计量模型。接口先由主线统一后，再按上述边界委派实现和 review。

## 7. 设计验收标准

- Auto-review 只替换 ask 的裁决者，一次决定只适用于确切调用，不扩大沙箱或持久扩大权限；失败默认 fail closed。
- 用户 Goal 能在同一 Thread 上跨普通 Assistant final response 持续推进；pause、needs_input、complete、context/provider limit、Runtime restart 均能恢复或正确停止。
- Agent 可以判断是否需要 Todo；开放 Todo 注入上下文，完成项被勾选并退出默认投影。
- Rolling Context 每个封段独立调用辅助模型直接总结；只有严格净成本预估完整且为正时才调用 Evaluator，未知成本时不调用 Reviewer、不自动转层。
- Warm 使用该段已有直接摘要，cold 不进入 prompt；三层变化从不删改 Canonical History。
- 用户能对照每次实际发送给 LLM 的原文和工具 schema，看到每个段如何投影、摘要替换和省略。
- 自动 Project / Global Memory 写入不要求逐条用户确认，分类范围正确且有源记录；UI 可手动增删改查、pin、纠错。
- Subagent 仍是普通 Child Thread，创建和消息具备重试幂等性，不增加同步 Join/Task 对象。
- Usage 能分辨主调用、重试、摘要、Reviewer 等辅助成本；不支持的 Provider 计费数据明确显示 unknown。

## 8. 参考

- Pico 的核心设计与不变量：[Agent Harness 核心架构与设计意图记录 v5](Agent_Harness_核心架构与设计意图记录_v5.md)、[实现护栏与实现锚点](IMPLEMENTATION_GUARDRAILS_设计哲学与实现锚点.md)。
- Codex Auto-review 文档：<https://learn.chatgpt.com/docs/sandboxing/auto-review>。参考 reviewer 替换、边界保持、逐次审查、明确 deny / timeout 和熔断行为。
- Codex Long-running work / Goal 文档：<https://learn.chatgpt.com/docs/long-running-work>。参考同一 Thread 内用户管理 Goal 的 pause / resume / edit / clear、验收条件和权限不变。
- LangGraph Persistence、Interrupts 与 recursion limit 文档：<https://langchain-ai.github.io/langgraph/concepts/durable_execution/>、<https://langchain-ai.github.io/langgraph/concepts/breakpoints/>、<https://langchain-ai.github.io/langgraph/troubleshooting/errors/GRAPH_RECURSION_LIMIT/>。参考 durable state、interrupt/resume、可恢复安全边界与循环上限；不复制其 Graph / Checkpoint 对象模型。
