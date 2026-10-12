**Agent Harness  
Implementation Guardrails**

设计哲学、实现锚点与自由度边界

*配套文档：Agent Harness 核心架构与设计意图记录 v5*

> 文档用途
> 这不是第二份架构设计，而是给实现者（尤其 coding agent）的行为约束。它回答三件事：哪些语义不能擅自改变；哪些只是默认选择；哪些实现细节可以自由发挥。遇到未覆盖场景时，应优先从设计哲学和已有不变量推导，而不是为了局部方便增加新的核心抽象。


# 1. 总体设计哲学

- 保持核心小而有力。能用 Thread、Message、Execution、Tool、Pipeline 表达的行为，不新增 Run、Intent、Task 等高层对象。

- 保存事实，不保存猜测。网络断连、UI 消失、executor unreachable 等只是条件；只有确认发生的状态变化才写成事实。

- 让模型理解语义，让 Harness 保证执行。Harness 不主动替模型维护“当前意图”“任务计划”“是否应该继续”等高层认知状态。

- 事实与解释分离。Canonical History/Log 是不可修改的事实来源；模型上下文只是基于这些事实生成的一次 Projection。

- 开放语义边界，而不是内部结构。插件扩展 Pipeline、Tools、Commands、UI semantic slots 等稳定概念，不依赖 Runtime 内部函数或 UI DOM/component tree。

- 网络不可靠是正常情况，不是异常特例。Message 与 Execution 都要有稳定身份，重试不得产生重复语义。

- 少做兼容包袱。0.x 阶段优先修正错误抽象；必要时迁移数据，不长期维护多套旧语义。

> 一句话
> Harness 应该像一个可靠的“agent 执行内核”，而不是一个把任务管理、IDE、分布式调度、账号系统和 AI 工作流全部揉在一起的平台。


# 2. MUST：不可擅自改变的架构锚点

**Canonical facts 不可修改：**Canonical History/Log 是事实依据，只允许追加。Projection、插件和 UI 都不能回写、删除或改写已提交事实。插件可追加 namespaced canonical record，但一旦写入同样不可修改。

**Context 与 History 分离：**模型实际看到的内容由 Projection 决定。Core 不保证某条 history、project context、memory 或 recovery hint 必须进入模型；Core 只提供事实与建议性输入来源。

**Thread 是长期核心工作单元：**Thread 属于 Project、固定绑定一个 Executor、最多有一条 active agent loop，并可无限次 idle → active → idle。Thread 没有 completed 状态。

**Message 是统一输入：**用户运行中追加消息、普通后续输入、child agent 反馈都使用 Message。所谓 steer 只是“消息在当前 agent loop 的下一个安全边界被模型看到”，不是独立核心对象。

**同一 Thread 只有一条 active agent loop：**Runtime 可同时推进多个 Thread，也可连接多个 Executor；并行通过多个 Thread、并行 Tool Calls 和 child threads 实现，而不是让同一 Thread 同时跑多条 agent loop。

**Tool Batch 并发且整批返回：**一次 Model Step 返回的一组 Tool Calls 必须允许并发执行，并在全部进入 terminal state 后作为同一批结果进入下一 Model Step。不得为了实现简单退化为逐个执行。

**Execution 最小事实状态固定：**Execution 至少支持 pending / running / completed / failed / interrupted。网络断连本身不改变 running；只有确认 execution 已无法继续时才进入 interrupted。

**Execution submission 去重：**稳定 execution_id 表示一次逻辑执行。Runtime 因网络丢 ACK 重复提交同一 execution_id 时，Executor 必须视为同一次执行，而不是再次执行 Tool。

**Message delivery 去重：**Message 具有稳定 message_id。发送方可因网络问题重试，Canonical Store 不得因此产生重复 Message。

**Pause 不等于 Interrupt：**Pause 只阻止下一个安全边界之后继续推进，不主动取消已经开始的 Model/Tool execution。Interrupt 是单独命令，尝试停止当前 execution。

**Thread UI 状态从事实派生：**不要维护不断膨胀的 ThreadStatus 状态机。至少应从 pause 意图和 active execution 事实派生 Idle / Running / Pausing / Paused。

**Runtime、UI、Executor 分离：**UI 负责交互；Runtime 推进 agent loop；Executor 执行 Tool 与现实副作用。不要因为默认部署在同一台机器就把这些边界写死。

**Thread 固定绑定一个 Executor：**同一 Thread 不在执行过程中切换 Executor。需要不同环境时，在同一 Project 新建 Thread，以 Project Context/插件共享上下文。

**Child agent 就是普通 Thread：**Subagent 不引入 SubagentTask/Join/Await/Result 等核心对象。Child Thread 只增加 parent/created_by 等 metadata，默认属于同 Project，仍可由用户直接打开和发消息。

**Subagent spawn 非阻塞：**spawn child thread 立即返回；main 与 child 通过 Message 双向通信，允许实时调整方向，形成真正并行协作。

**Canonical Logger 与 Execution Pipeline 正交：**Pipeline 只影响尚未成为事实的未来行为；Logger 只记录已经发生的事实。Pipeline 不能反向修改 Logger 中的既有记录。

**Pipeline stage 按领域语义定义：**v0 采用 step / projection / model / toolBatch / toolInvocation。新增 stage 应因为出现无法表达的稳定领域操作，而不是因为某个插件希望多一个专用 before/after hook。

**插件不是互斥类型：**所谓 Tool Plugin 与 Workflow Plugin 只是用途上的称呼。技术上一个插件可同时注册 tools、修改 pipelines、注册 commands、贡献 UI、维护 state、写 canonical records。

**显式后台 spawn 脱离 Tool 生命周期：**普通子进程属于 Tool execution 生命周期；显式 spawn 成功后的后台进程就是环境中的普通进程，不引入 Harness 级 Process Manager。

**Question 不是默认能力：**如果提供 question，它是可选且阻塞的 Tool。非阻塞“提问”应使用普通文本输出，用户需要时自然通过 Message/steer 回应。

# 3. SHOULD：默认方案与设计倾向

**OpenAI-compatible first：**第一版优先支持 OpenAI-compatible。Core 使用薄的内部 Model Adapter，避免 wire-format 细节扩散到 Runtime。Anthropic 等可后续增加。

**Container Executor 作为默认：**默认通过容器运行 Tool，workspace bind mount 进入容器，容器内 root 可自由配置工具链而不污染宿主。Host Executor 同样是一等选项。

**Executor 应尽可能“无知”：**Executor 应主要知道 Tool、Execution、环境与连接，不应该理解 Project、Thread、Model、Memory、Subagent、Goal 等 Harness 语义。这样 Executor 才能在容器、Host、远端服务器、不同 OS 上稳定复用，而不会被某种产品工作流绑死。

**Runtime 不要摊得太扁：**不要做一个巨大 Runtime 类直接管理 provider、history、plugins、executor transport、UI command、storage 等所有细节。保持清晰的内部层次与可替换服务边界，但也不要为了“分层”创造大量空壳对象。

**语义层次高于实现层次：**Pipeline、UI slot、Command、Tool 等公共接口应使用领域名称，不要暴露当前函数名、组件树或数据库表结构。

**UI extension 使用 semantic slots：**插件通过 thread toolbar、composer action、sidebar panel、tool renderer、settings、command palette 等语义位置扩展 UI，不直接依赖 DOM 或具体前端组件层级。

**Slash Command 是用户 Action：**/compact、/permissions 等命令先由 Command Router 处理，不必伪装成 Message 发送给模型。Command 可触发 Runtime API、插件状态、UI 或显式发消息。

**插件默认拥有真正的行为修改能力：**Pipeline interceptor 可以 wrap、short-circuit、replace 尚未 commit 的行为；不要把插件降级成只能观察的一组 hook。

**插件顺序显式且可观察：**同一 stage 上多个 interceptor 的执行顺序必须确定并可检查。不要依赖偶然加载顺序；强依赖关系可由配置或 manifest 表达。

**UI 要让状态“看得懂”而不是“功能堆满”：**优先把 Running / Pausing / Paused、Executor 连接、Tool Batch、Child Thread、Permission 等状态表达清楚；不要一开始复制 IDE 的文件树、Git 面板和多级工具栏。

**移动端是正常客户端，不是降级版：**核心操作应在窄屏和触屏上自然完成：发消息、Pause/Interrupt/Continue、查看 Tool、切 Thread、查看 Child Thread、审批 Permission。避免依赖 hover、超宽布局或复杂拖拽。

**失败提示应贴近事实：**比如 Executor unreachable、provider limit、context limit 应说明“哪里出了问题”和“当前 execution 事实是什么”，而不是统一显示模糊的 Disconnected/Error。

**默认交互少打断：**Question、Permission 等阻塞体验都应可配置；默认 Harness 不应因为“可能需要确认”而频繁停止 Agent。用户可通过插件选择更保守或更自动化的工作流。

**Executor 连接方式保持中立：**允许手动启动并连接 Executor，也可未来增加发现机制；不要把 localhost、LAN、域名、公网、Tailscale 等任何一种网络拓扑写成架构前提。

# 4. MAY：实现可以自由发挥的区域

- 内部代码目录、类名、模块拆分、monorepo 结构。

- Runtime 与 Executor 的具体 RPC/HTTP/WebSocket 协议，只要语义满足去重、状态查询和中断。

- SQLite / IndexedDB / append log / materialized view 等存储实现与 schema。

- Pipeline 的具体 compose 实现、middleware 风格、泛型接口或 service decorator。

- Vue/React/Svelte 等 UI 技术栈与具体视觉布局。

- Docker/Podman、Executor Profile/Instance、cache volume 等容器细节。

- Plugin manifest 文件格式、打包工具和安装目录。

- Model Adapter 是否借助 Vercel AI SDK 等第三方库，只要不把其抽象反向绑死 Core。

- Usage、日志、tracing、metrics 的具体实现。

- Project Context、Memory、Rolling Context、Goal、Permission 的具体算法与 UI。

# 5. DEFER：v0 不要主动扩大范围

- 新的 Run / Intent / Task 核心对象。

- 中心账号系统、强制云同步或必须存在的中央服务器。

- 自动判断“这个重连后的环境是不是原来的逻辑 Executor”。

- 跨多个 Executor 的单 Agent 动态调度。

- 通用 Process Resource Manager、后台进程所有权树和自动孤儿清理。

- 自动 token budget manager；平时展示消耗，撞 provider/context 限额时暂停即可。

- 插件市场、复杂版本兼容层和长期旧 API shims。

- 完整 IDE 化：文件树、Git GUI、复杂编辑器、多窗格终端等可后续按真实需求添加。

- 高级 P2P/CRDT Sync。先保证 Store/Canonical 边界允许以后接入。

- 过早抽象所有 Remote/Browser/VM Executor 形态。先做好 Container + Host。

# 6. UI / UX 设计哲学

## 6.1 UI 是状态与控制的窗口，不是另一个运行时

UI 不应偷偷持有只有自己知道的业务状态。关闭浏览器、刷新页面或换设备后，用户应能通过 Runtime/Store 中的事实恢复当前 Thread。UI 可以缓存展示状态，但不能成为 canonical owner。

## 6.2 让用户理解“现在发生了什么”

- 清楚区分 Runtime 是否在工作、Executor 是否可达、Tool 是否仍在执行、Thread 是否处于 Pause 意图。

- Pause 后当前 Tool 仍在运行时，应展示 Pausing，而不是假装已经停止。

- 只有用户显式 Interrupt 才尝试终止当前 execution。

- Child Thread 默认可折叠或隐藏，但必须可访问、可阅读、可直接发消息。

- Tool Card 默认折叠长输出，但关键状态、失败原因和 interrupted/unknown effect 必须明显。

## 6.3 不追求 IDE 复刻

第一目标是让“和 Agent 协作”舒服，而不是把 VS Code 搬进浏览器。对话、Tool 状态、Thread/Child Thread、Executor、Pause/Interrupt/Continue、Permission、Command 是一等交互；文件树、Git GUI、复杂终端布局只有真实使用证明必要时再增加。

## 6.4 桌面与手机保持同一种心智模型

不要因为手机屏幕小就创造另一套“移动模式”。可以改变布局和控件密度，但 Thread、Executor、Child Thread、Command、Pause 等语义必须一致。

# 7. Runtime 架构哲学

## 7.1 不要“摊平”为一个万能对象

Runtime 是组合者，不是所有实现细节的容器。Model Adapter、Projection、Pipeline、Executor Connection、Canonical Store、Plugin Host 等应有清晰边界。这样后续替换某个 Provider、Store 或 Host 时不会牵动整个系统。

## 7.2 也不要过度分层

分层的目的在于保护语义边界，不是追求 UML 数量。没有独立生命周期、替换需求或安全边界的对象，不要仅因为“架构看起来更规范”而拆成 service/interface/factory 三层。

## 7.3 Runtime 是可丢弃的推进器

Browser Host、Daemon Host、Desktop Host 都只是承载 Runtime 的地方。Host 消失后，不应导致 Thread 历史或 Tool 副作用语义丢失。恢复时依靠 durable facts 和 Execution 状态继续。

## 7.4 不替模型做高层认知管理

Runtime 不维护“当前任务意图”“计划阶段”“是否在等待 subagent”等高层状态。用户和 Agent 的新信息通过 Message 进入；Child Thread 通过 Message 协作；需要 Goal/Plan 的用户可安装插件。

# 8. Executor 架构哲学

## 8.1 Executor 越“无知”越可复用

Executor 的理想职责是：暴露 Tool、接收带稳定 ID 的 Execution、报告状态、接受 Interrupt、运行 Tool Plugin。它不需要知道当前属于哪个 Project、Thread 为什么存在、模型是谁、Project Context 如何构造或 Child Agent 是什么。

> 为什么
> 一旦 Executor 开始理解 Thread/Project/Memory 等 Harness 语义，它就会依赖特定产品工作流，并很难作为通用 Host/Container/Remote 执行边界复用。保持无知可以让同一个 Executor 实现在 Linux 容器、Windows Host、远端服务器等环境中工作。


## 8.2 环境差异属于 Tool 与部署，不属于 Harness 语义

Windows、Linux、CUDA、Android SDK、Docker、SSH 等差异应通过 Executor 环境和 Tool surface 表达。Runtime 只看到“当前 Executor 提供哪些 Tool”。不要在 Runtime 中出现 if windows / if docker / if remote 之类环境分支。

## 8.3 Container 是安全默认，不是唯一正确答案

默认 Container Executor 通过隔离和容器内 root 提供干净工具链；用户若已有成熟宿主环境，可长期使用 Host Executor。Permission 继续作为行为层约束，不应把容器本身误当成完整授权系统。

# 9. 插件实现哲学

- 插件 API 只暴露稳定语义面：tools、pipelines、commands、ui、state、canonical。

- Workflow Plugin 可以同时注册 Tool；Tool Plugin 也可以有 UI renderer 或 Command。不要通过插件类型人为限制组合。

- UI/Runtime/Executor 可分进程，因此插件设计不要假定所有 entrypoint 永远在同一个进程。必要时允许 runtime/ui/executor 多 entrypoint。

- 先增加“能力面”，再增加“专用 Hook”。已有 Pipeline 能表达的需求，不新增 onBeforeXxx/onAfterXxx。

- 如果以后某个真实需求无法在现有 stage 表达，可以增加新的稳定语义 stage；这是可接受的演进，不需要 v0 猜完所有扩展点。

- 插件可修改未来行为，但不可修改已经提交的 canonical facts。

# 10. 实现 Agent 的决策规则

1.  遇到文档未覆盖的问题时，先尝试使用现有 Thread / Message / Execution / Tool / Pipeline 组合表达。

2.  如果需要新增核心对象或改变 MUST 语义，暂停实现，把问题上升为设计决策；不要自行“补全成熟 Harness 应该有的东西”。

3.  如果只是内部组织、传输协议、数据库 schema、UI 技术细节，优先选择最简单、容易测试和替换的实现。

4.  优先让事实状态可观察、可 debug，再追求自动魔法。网络失败时宁可保持 pending/running 并要求明确恢复，也不要猜测。

5.  新增抽象前问：它是否拥有独立语义、生命周期或安全边界？如果没有，很可能只是现有对象的 metadata、Tool、Message 或插件状态。

6.  实现新功能时同时检查手机/远程/网络波动场景，但不要因此提前实现完整分布式系统。

# 11. 反模式清单

- 为了 compact 直接改写历史记录。

- Pause 时默认 cancel 当前 Tool/Model。

- Executor 一断线就把所有 running executions 标成 failed/interrupted。

- 在一个 Thread 中动态切换 Executor。

- 把 Subagent 做成同步阻塞函数调用并让 Main 等待返回。

- 为了“提问用户”内置默认阻塞 question，而不是让用户选择插件/工作流。

- 让 Runtime 根据操作系统、容器类型、SSH 环境写大量条件分支。

- 让 Executor 读取 Project Context、Memory 或理解 Thread workflow。

- 让插件直接操作 UI DOM/组件内部状态。

- 为了统计/日志引入独立插件体系，而不是使用 Pipeline/Canonical 现有能力。

- 为了“完整”一次性实现 remote executor、P2P sync、plugin marketplace、process manager。

- 把 implementation convenience 升格为新的领域对象。

# 12. 建议的 v0 验收心智模型

Project  
├─ Thread A ── Container Executor  
│ ├─ Messages / Canonical facts  
│ ├─ one active agent loop  
│ └─ Child Thread A1  
└─ Thread B ── Host Executor  
  
Runtime  
├─ projection pipeline  
├─ model pipeline  
├─ toolBatch pipeline  
└─ toolInvocation pipeline  
  
UI  
└─ observe + control Runtime; does not own facts

如果 v0 能稳定完成“创建 Project → 新建 Thread → 连接/选择 Executor → 发消息 → Model/并行 Tool Batch 循环 → 运行中追加消息 → Pause/Interrupt/Continue → spawn Child Thread 并双向通信 → Runtime/Executor 网络波动后恢复”，就已经构成一个完整 Harness，而不是 demo。
