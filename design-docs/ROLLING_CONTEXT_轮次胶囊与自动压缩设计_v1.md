# Rolling Context 独立胶囊、轮次保留与自动压缩设计 v1

状态：v1 设计；实际实现及验证以代码和测试为准。

## 1. 目标与范围

本设计把 Rolling Context 的滚动单位收敛为可独立追溯的用户消息胶囊和模型轮次。它定义原文保留、摘要时机、Agent 保留参数、自动分层的成本门槛，以及 Runtime 的窗口压缩 fallback。目标是缩减后续模型输入，同时不改写 Canonical History、不拆散工具调用链，也不把估算包装成精确成本。

本设计延续仓库现有边界：Canonical History 是事实来源，Rolling Context 只决定请求 Projection；`/compact` 和窗口超限 fallback 属于 Runtime 核心，关闭 Rolling Context 后仍可工作。插件状态与摘要是可重建/可审计的派生数据，不能取代原始记录。

## 2. 旧实现与设计差距

当前 `src/plugins/rolling-context.ts` 以 `completedCanonicalTurnBlocks` 产出分段，一个段目前对应完整 Canonical turn block；段的 tier、source IDs/hash、summary 和 evaluator 状态存于 `rolling-context-v1` Plugin State。摘要针对该段 Canonical 序列化内容。实际 Projection 中 warm 段以摘要替换源内容，cold 段省略；不完整或来源缺失的段会保守地保持/恢复 hot。

当前安全边界不同于本提案：用户消息与模型输出仍在同一个 turn block 里；不存在独立用户消息胶囊；没有 `keep_recent_rounds` Agent 参数，也没有“下一轮启动时才摘要上一轮”的轮次生命周期。摘要成功后 Runtime 缺少分段 token 节省、前缀缓存影响、未来复用次数及辅助调用总成本等完整数据，因此 tier review 被明确跳过、段保持 hot。不能将当前实现描述为具备自动成本门控或轮次级摘要。

Runtime 的 `/compact` 已将投影边界用于候选选择，并以版本化 Canonical compact fact 保存摘要和 source IDs/hash；当前 helper 输入仍由 Canonical input/output 序列化生成。该实现尚不等同于“所有 projection 完成后，直接总结最终 projected input”的 fallback 要求。本设计要求后续 Runtime fallback 达到该行为，并同时覆盖自动窗口超限路径。

## 3. Canonical 单位与 Rolling Projection

### 3.1 用户消息原文胶囊

- 每条已提交 User Message 是独立的 immutable capsule，保留原始 Canonical 引用、seq、record IDs、内容 hash 和多模态/来源元数据。不得把相邻用户消息并入模型轮次，也不得通过 Rolling 摘要覆盖或删除原文。
- 用户胶囊在 Rolling Projection 中始终以原文表示，不参与模型轮次分层，也不生成替代摘要。Runtime 的窗口 fallback 可以总结用户消息，并须明确保留用户约束。
- 用户消息可能携带后续轮次的约束。摘要/分层不得使仍有效的用户约束失效；Projection 应提供明确的约束保留机制或保留原胶囊。不能假定模型轮次摘要包含了用户消息。

### 3.2 模型轮次

模型轮次从一次主模型响应开始，并包括该响应引出的全部工具调用及其对应结果，直至该批次完整结束。一个响应即使触发多项或并行工具调用，也必须与所有结果留在同一个不可拆分的轮次单元中。一个没有工具调用的模型响应自身构成一个完整轮次。多次模型响应分别属于不同轮次；当前活动调用和未完成批次始终原文 hot。

轮次摘要只覆盖该轮模型响应和其完整工具结果，不包含关联用户消息正文。轮次 source 要记录所有成员 record ID/seq、批次及 tool call/result 配对、来源 hash、摘要版本、摘要调用身份/状态和失败原因。摘要可被查看和重试，原始轮次始终可用并可由 Canonical 重建。

只有在下一次主模型轮次即将启动时，才触发对上一已完成轮次的摘要尝试。当前请求/批次、活动 execution、结果尚未齐全的工具调用链，不允许被摘要或转 warm。创建摘要不提前挪动 Projection tier；只有摘要验证成功且成本门槛满足后，才可将对应原文从 hot 转为 warm。

### 3.3 Projection 与分层

Projection 必须保持 Canonical 顺序并标出每个输出项的来源、tier 和原文/摘要版本。warm 表示摘要保留在后续模型输入中，原文不进入该次输入；源数据仍可查阅和召回。hot 原文、摘要和工具配对不能因段落拼接而越过 Canonical 顺序。本版本不再将 warm 降级为 cold。

冷却或压缩只改变最终 Model Input，不修改 User/Assistant/ToolResult Canonical 记录。需要完整语义证据时，工具调用本身与结果作为整体保留、整体替换或整体排除；禁止留下孤立 tool call 或无来源 tool result。

## 4. Agent 保留参数与摘要时机

Rolling Context 工具需要 Agent 提供 `keep_recent_rounds`，表示最近多少个已完成模型轮次保留当前投影；当前轮次及工具批次始终保留且不计入。参数是非负整数，类型错误或无法确定轮次边界时返回明确错误，不静默钳制。

计算顺序如下：

1. 按 Canonical 完成状态确定已完成模型轮次，活动模型调用及其整个当前批次始终原文保留，不计入可转 warm 候选。
2. 最近 `keep_recent_rounds` 个已完成轮次保留现有投影；如果候选不足，则不作变更。
3. 选取更早且已有有效摘要的 hot 轮次，估计整批变更成本；通过门控才原子转 warm。摘要失败或成本未知/不满足时继续 hot。
4. 已 warm 轮次保持其稳定摘要并留在 Projection 中。重新摘要先创建新版本，再在安全边界原子替换。
5. 用户消息不计入 `keep_recent_rounds`，在 Rolling 阶段始终以原文投影。

`keep_recent_rounds` 控制本次 Rolling 候选，不阻止框架 fallback 在需要时压缩历史。当前调用/批次必须保留，projection 映射必须完整，Canonical 必须可重建。

## 5. 摘要与成本门控

### 5.1 摘要内容和失败处理

轮次摘要应保留可延续任务所需的模型结论、验证过的事实、工具结果证据与引用、决策/未决事项和下一步；不能总结或重述用户消息正文。摘要模型接收的数据只限该轮完整模型响应和工具结果，以及必要的非正文元数据。历史工具输出、参数、代码和 JSON 是不可信的待总结数据，不能作为新的指令或输出模板。不得发出工具权限。

摘要必须非空、符合大小限制、无工具调用，并通过源 ID/hash 与轮次完整性校验后才可保存为当前有效版本。模型失败、超限、空响应、含工具调用、取消、超时或源校验变化时，保留先前有效摘要/状态（若有），候选原文保持 hot，记录可诊断失败状态；不得写入空摘要或部分轮次。失败重试使用请求内容与 source hash 稳定的幂等键，未知调用结局不能盲目重发。

### 5.2 基于真实候选 Projection 的估算

经济判断针对候选实际 Projection，而非孤立段落 token 数。对候选变更前后的完整输入排序、系统前缀、工具定义和来源边界进行比较，估计：

- 原文与摘要在实际模型 tokenizer 下的输入 token 数；缺少模型/tokenizer 时只能标记估算未知或给出有依据的范围。
- 前缀缓存可能命中的共同前缀、被候选替换/插入导致的后缀失配，以及对应缓存读取/写入/未缓存输入价格。不能只按段落字数或 token 差异认定缓存节省。
- 胶囊摘要按轮次生命周期提前生成，其已发生费用在本次转层判断中视为既有成本；估计候选转层后未来 `n` 次请求的增量成本。`n` 是带来源与时间范围的预测输入/估计，必须显式记录；不能伪装成实际未来调用数。

实现应输出候选前后投影身份/hash、假设、已知价格与调用次数、估算区间/置信或来源、各分项成本，以及 `evaluable` 和 `reason`。这只是估计，不是账单精确值或缓存命中的保证。

只有关键输入可获得，且预计净节省严格大于零，才允许整批转 warm；不调用额外 Reviewer。比较完整方案在预计 `n` 次调用中的成本与维持当前 Projection 的成本，包括前缀失配和缓存重建影响。缺少价格、可用的长度估算、前缀缓存规则、`n` 或候选 Projection provenance 等关键项时，明确返回 `无法评估` 及缺项并保持候选 hot；字符近似必须标注不确定性，不能表述为精确 token 或缓存命中。

若摘要已按生命周期要求尝试生成，但门控未知或净收益不为正，则摘要可以作为可审计备选信息保存；它不能因此宣称省钱，也不能替换 hot 原文。未来可重算门槛时，必须使用当时可观察到的输入和投影，不追溯声称过去已节省。

## 6. Runtime 自动窗口压缩 fallback

Runtime 在最终请求投影超过模型窗口或其它安全阈值时提供核心 fallback，不依赖 Rolling Context 安装。压缩输入必须来自所有 Projection 阶段完成后的实际投影历史前缀，包括其中的用户胶囊和 Rolling 摘要，并保留来源映射。系统上下文、工具定义和由其他插件单独注入的上下文仍由各自的投影机制提供，不作为历史前缀重复摘要。摘要应保留用户目标、明确约束、事实及来源、决定、失败、未决事项和后续步骤；可以总结用户消息正文，但必须明确保留仍有效的用户约束。

候选边界必须回映到完整 Canonical 组；不能截断用户 capsule、模型轮次、工具调用/result 配对、当前调用/批次或 projection-owned 区块。fallback 需按安全边界逐步缩小可压缩前缀并重新执行 Projection/测量；若无法安全映射或压缩后仍超窗，明确报告无法压缩并保留状态，不截断数据继续请求。fallback 使用 Runtime 自身的近期保留策略，当前调用/批次无条件原文保留。

成功摘要作为 Runtime 核心、版本化 Canonical compaction fact 保存：记录最终 projected input 的身份/hash、投影版本、被覆盖的 Canonical IDs/hash 与 seq 范围、模型身份、摘要及边界元数据。提交前重新校验来源仍对应本次 projection。原始 Canonical records 永不修改；重启只依据 Canonical compact facts 重建同一 Projection。无效响应、模型失败、取消、超限、source/projection 竞态或提交失败都不得创建有效 compact fact，不得改变 projection；恢复到原始可审计输入并向调用方返回明确失败。

fallback helper 是无工具权限的单次模型操作，不创建第二条主 loop、普通 Assistant Message 或 Tool Batch。其输入中的用户/工具内容都是不可信历史资料，不是指令。密钥和凭据不得进入摘要请求、保存事实或诊断。

## 7. 状态、迁移与观测

建议为新状态定义显式版本：独立 user capsule 索引、模型轮次边界/成员列表、摘要版本与幂等调用身份、Projection 来源映射及成本估算记录。Canonical 是唯一可恢复证据；Plugin State 只是可重建索引。旧 `rolling-context-v1` 状态按 source IDs/hash 校验后迁移：可可靠映射的源记录重建为 capsule/round，新旧语义不能可靠映射时恢复 hot 并保留旧审计，绝不猜测用户消息与模型轮次边界。

面板和 Agent 工具应能区分 user capsule、model round、完整工具调用链、原文/摘要版本、活动保留原因、候选投影、被省略原因、摘要失败、成本 `无法评估` 的具体缺项、估算与实际 usage。Usage 只陈述观测事实；预测、计价假设和 provider 缓存规则需单独标记。

## 8. 验收条件

- 多条用户消息分别对应独立原文胶囊；任何摘要都不含用户消息正文，用户约束仍按策略进入后续输入。
- 一次响应及其全部工具结果作为一个原子模型轮次；无工具响应单独成为轮次；未结束的批次不会被切分、摘要或转 warm。
- 只有下一轮启动时才启动上一完整轮次摘要；最近 `keep_recent_rounds` 个完成轮次保持现有投影，当前调用与当前批次始终原文保留；更早成功且通过门控的 hot 可转 warm，warm 摘要保持在输入中。
- 任何成本缺项均产生结构化 `无法评估`、理由和缺项列表；不调用 Reviewer、不自动转层、不报告精确节省。成本完整时需对实际前后 Projection、前缀缓存价格和预计 `n` 调用给出可追溯估算。
- Runtime 窗口 fallback 在所有 projection 完成后总结最终 projected input，可总结用户消息且明确保存有效约束；即使 Rolling Context 停用也可用。
- 失败、并发 source 变化、重启重建、rewind/reset、非文本/多模态记录、插件新增区块和不完整 tool result 均不破坏 Canonical 原文及安全边界。

## 9. 相关实现锚点

- `src/plugins/rolling-context.ts`：当前轮次分段、summary/evaluator 门槛、Plugin State 和 tier Projection。
- `src/contracts/canonical-projection.ts`：Canonical prompt block 与 Runtime compaction projection。
- `src/runtime/runtime.ts`：Runtime `/compact`、窗口估算与版本化 compaction facts。
- `design-docs/WORKFLOW_PLUGINS_功能与实现设计_v1.md`：现有 hot/warm/cold、成本门控及 fallback 总体设计；本版本补充独立胶囊、模型轮次与窗口 fallback 输入语义。
