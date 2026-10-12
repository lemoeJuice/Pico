**状态：设计讨论整理稿**

目的：既记录“决定了什么”，也记录“为什么这样决定”

> **阅读说明：**本文件不是 API 定稿，也不是 v1 功能清单。它首先是一份“设计意图保护文档”：后续实现遇到未覆盖场景时，应优先从本文的核心边界和理由推导，而不是为了局部方便引入违和的新机制。

# 0. 文档目标与当前结论

本项目最初从“Pi 的 TUI 体验不够好，是否改成 Web”出发，但讨论逐渐发现，不满意点并不只在 UI，而是触及 session、执行恢复、权限、插件边界、项目上下文和运行拓扑。因此目标已经从“换一个前端”演化为：设计一个更小、更自洽、local-first / self-hostable 的 agent harness。

当前最重要的不是尽快复制 Pi/OpenCode 的全部功能，而是先固定一组足够清楚的核心语义，让 UI、Executor、同步方式、容器实现和具体模型后端都可以后续替换。

Project  
└─ shared project context / memory  
  
Thread  
├─ fixed Executor  
├─ canonical Message history  
└─ at most one active agent loop  
  
UI ↔ Agent Runtime ↔ Executor  
│ │  
├─ workflow ├─ tool plugins  
├─ context ├─ execution state  
└─ model loop └─ side effects  
  
One Runtime may advance many Threads; one Executor may serve many Threads concurrently.  
Store / Sync provide durability and cross-device continuity.

> **设计意图：**后续实现若必须在“局部方便”和“边界清楚”之间做取舍，应优先保住边界。项目用户规模较小，允许通过 breaking change + migration 修正早期错误，不必为了旧版本兼容长期背负复杂度。

# 1. 为什么不是简单 Fork Pi 或只做 Web UI

用户使用 Pi 时遇到的主要问题并不是单纯“界面不好看”，而是几处核心抽象与实际工作流不匹配。

- Pi 的 session tree 会把网络错误、provider 失败等执行层事件写进历史；session tree 除了回退这些错误外，实际价值有限。

- 权限控制难以获得既安全又不打扰的体验，并且容易与具体工具、插件和 UI 纠缠。

- 插件化不彻底：插件有较多限制，很多高级需求需要依赖作者事先预留的 hook。

- TUI 交互体验不够顺手，daemon 上的一些人工选择/审批界面也显得别扭。

- Codex 的 memory / continuity 思路有可取之处，但 Chat / Work / Codex 等产品边界偏复杂；本项目更希望直接本地运行并通过任意网络方式访问。

> **设计意图：**因此核心目标不是“做一个更漂亮的 Pi”，而是把 agent runtime、执行环境和 UI 真正拆开。Fork Pi 如果深入修改 session model、extension lifecycle、context construction、tool execution semantics，会逐渐同时背负 Pi 的复杂度和自定义架构的复杂度。

## 1.1 小众项目的结构性优势

如果主要由少量用户使用，就没有必要过早承诺长期兼容所有旧 schema、旧 plugin API 和旧行为。更推荐：

- 0.x 阶段允许 breaking change。

- 优先稳定核心语义，而不是便利 API。

- 数据格式变化时优先做一次性 migration，而不是 runtime 永久兼容多套旧逻辑。

- 插件 API 早期可以明确拒绝旧版本加载，并提供迁移说明。

> **设计意图：**“没人用所以可以随便改”仍然可能造成内部失控，因此自由的前提是尽早固定 architectural invariants。实现形式可以变，核心语义不要悄悄漂移。

# 2. 核心对象与职责边界

避免使用含义过宽的 frontend/backend。系统内部建议直接使用 UI、Runtime、Executor、Store、Sync 等角色名称。

## 2.1 UI

- 纯人机交互客户端：展示 thread/history、tool progress、permission prompt、运行状态。

- 发出 send / steer / pause / continue / abort / approve 等控制命令。

- UI 不需要理解 agent loop，也不应成为 durable state 的唯一持有者。

## 2.2 Agent Runtime / Harness Core

- 推进 agent loop。

- 构造 context、调用模型、接收 model tool request。

- 加载 workflow plugins。

- 维护 Thread agent-loop 的 idle / running / paused 状态，以及 pause / continue / interrupt 和消息调度语义。

- 在恢复时读取 durable state，并根据 Executor 当前报告的 execution 状态继续；若 Executor 重启后确认原 execution 已丢失，则将其转为 interrupted，由模型在后续上下文中检查现实状态。

> **设计意图：**Runtime 才是系统中真正“主动”的控制层。浏览器 UI 只是 UI；Runtime 可以嵌进浏览器，也可以在常驻 daemon/desktop/CLI host 中运行。

## 2.3 Executor

- 托管 Tool Plugins。

- 真正执行 tool invocation 并产生现实副作用。

- 维护 execution_id、tool execution 状态、tool result，并接受 interrupt 请求；显式 detached/spawn 的后台系统进程不要求由 Harness 额外管理。

- 与 agent memory、project context、subagent orchestration 等无关。

## 2.4 Store 与 Sync

- Store 保存 durable Thread / Project / Message / execution 等状态；不要求引入独立 Run 对象。

- Sync 负责跨设备复制需要共享的 durable state。

- Sync 不等于账号系统，也不绑定 Tailscale、中心服务或任何固定网络拓扑。

UI 人机交互，可以随时消失  
Runtime 推进 agent loop  
Executor 执行工具和副作用  
Store 保存 durable state  
Sync 在节点之间复制相关 state

# 3. Project / Thread / Agent Loop 的层级

## 3.1 Project

Project 是长期共享知识边界。不同 thread 即使使用不同 executor，也应该共享项目目标、架构决策、约束、近期状态和必要的历史结论。

## 3.2 Thread

Thread 是一次连续的工作上下文。一个 thread 在创建时选择 executor，并在整个生命周期内保持绑定不变。

> **设计意图：**不建议同一个 thread 中途切 executor。模型已经基于 cwd、OS、tool surface、之前执行结果形成上下文；突然切换执行环境会让这些假设失效。需要换环境时，在同一 Project 下新建 Thread，依靠 Project Context 保持连续性。

## 3.3 Agent Loop（Run 不作为一等对象）

后续讨论认为没有必要为每次用户请求再引入独立 Run/Intent 对象。Thread 自身保存连续历史，并且在任一时刻最多只有一条 active agent loop。收到消息时，如果 Thread idle 就启动 loop；如果正在 running，消息进入历史并在下一次 model step 可见；如果 paused，则只保存消息，等待 Continue。

Project  
├─ Thread A → Container Executor (idle / running / paused)  
├─ Thread B → Host Executor (idle / running / paused)  
└─ Thread C → Remote Executor / None  
  
一个 Runtime 可以同时推进多个 Thread；一个 Executor 也可以并发服务多个 Thread。

# 4. Durable / Resumable Agent Loop

这是本设计最核心的体验目标之一：工作流因为网络错误、浏览器关闭、用户停止等原因断掉后，不需要回退 conversation，也不需要重新告诉模型“继续刚才的任务”。

## 4.1 Conversation 不等于执行日志

Canonical conversation 应只保存真正构成 agent 语义上下文的内容。provider timeout、retry、latency、网络错误等属于 execution attempt/debug log，不属于对话本身。

User Message  
↓  
Thread Agent Loop  
↓  
Model Attempt \#1 ── network error (debug only)  
↓ retry  
Model Attempt \#2 ── committed  
↓  
Tool Batch ── concurrent, all settled  
↓  
continue loop

> **设计意图：**核心原则：Failures terminate attempts, not intent. 失败结束的是某次 attempt，而不是整个用户意图。

## 4.2 Model step 的 commit boundary

模型 streaming 到一半断开时，partial output 可以用于 debug 或 UI 暂存，但不应该直接成为 canonical assistant message。只有完整 model step 成功后才 commit。

## 4.3 Stop / Pause / Continue

Pause 的语义是“不再启动新的 agent-loop step”，而不是立即取消当前正在运行的 tool。若仍有 tool 在执行，UI 可以额外提供 Interrupt；只有用户执行 Interrupt 时，Runtime 才请求 Executor 尝试停止这些 execution。再次 Continue 时：

1.  加载 durable Thread / execution state。

2.  读取当前 tool batch / execution 的持久状态。

3.  若 Executor 重启后发现原本 running 的 execution 已丢失，将其标记为 interrupted；不要依赖 tool 自己声称能够可靠恢复现实副作用。

4.  重建 context；若存在 interrupted execution，加入明确的恢复提示，要求 agent 先检查现实状态。

5.  继续该 Thread 的 agent loop。

## 4.4 Thread execution 状态尽量简单

idle  
running  
paused

network_error、controller_lost、provider/context limit、user_pause 等更适合作为 paused 的 reason，而不是不断增加新的顶层状态。收到新消息时，idle Thread 自动启动；paused Thread 不因新消息自动恢复。

# 5. Tool Execution 与并发语义

Harness 不应假设任意 tool 都能可靠判断中断后的现实副作用。Harness 需要保证 execution 状态诚实、可持久化，并把不确定性暴露给模型；模型负责重新观察环境并做判断。

ToolExecution  
pending  
running  
completed(result)  
failed(error)  
interrupted

## 5.1 稳定的 execution identity

- 每次 tool call 有稳定 execution_id / tool_call_id。

- Executor 提供 execute / status / interrupt 等最小能力。

- 恢复时不能用“没有 result = 重新执行”这样的假设；interrupted 表示执行没有正常完成且现实副作用可能部分发生。

## 5.2 并行 Tool Batch

- 一次 model step 返回的一组 tool calls 视为同一个 Tool Batch；Batch 内 calls 可以并发执行。

- Runtime 等待同一 Batch 内所有 calls settled 后，再把整组结果一起返回给下一次 model step。

- Batch 内每个 call 可以分别 completed / failed / interrupted；Harness 不因为其中一个失败就替 agent 推断或回滚其它调用。

- 如果某个 call 被 interrupted，下一轮 context 中明确提示其现实状态未知，要求 agent 检查当前环境后再决定是否重试或采取其他动作。

> 设计意图：当 execution 被标记为 interrupted 时，Runtime 应诚实地告诉 agent“调用没有确认完成，现实副作用可能部分发生”，并要求 agent 检查当前环境，而不是依赖 tool 自证或偷偷重跑。

## 5.3 普通子进程与 detached/spawn 进程

普通由 tool 启动的子进程属于该 tool execution 的生命周期，tool 完成或被成功 Interrupt 时由 tool 自己处理。若用户/agent 明确使用 spawn/detach 启动后台任务，则进程在启动成功后脱离 tool 和 Runtime 生命周期，Harness 不额外维护其生命周期；用户或 agent 可通过普通系统工具自行查看和 kill。

tool-managed process → follows tool execution lifetime  
explicit spawn/detach → ordinary OS background process  
survives Runtime/UI shutdown  
inspect/kill through normal tools

# 6. 用户消息、Steer 与调度

后续讨论进一步简化：Steer 不需要成为特殊的 ContextItem，也不需要 Harness 原生维护 Intent。Steer 本质上只是 Thread 正在 running 时又收到了一条普通用户消息；它被正常写入历史，并在下一次尚未开始的 model step 中可见。

message while running → append to Thread; next model step sees it (“steer”)  
message while idle → append to Thread; start agent loop  
message while paused → append to Thread; remain paused until Continue  
Pause → stop advancing after current tool batch  
Interrupt → explicitly try to stop currently running tool executions

> 设计意图：Steer 不需要特殊对象。它只是 running Thread 中新到达的一条普通消息；当前 Tool Batch 不被隐式中断，消息在下一次 model step 自然可见。若用户确实想停当前 tool，使用显式 Interrupt。

# 7. Executor：执行边界，而不是分布式调度器

讨论中明确收敛为：一个具体 Thread 只绑定一个 Executor。Executor 的价值主要不是让一个 agent 在多台机器之间动态选执行位置，而是提供稳定的工具、权限和副作用边界。

## 7.1 为什么不做单 agent 多 executor

- 会增加 workspace 一致性、tool surface、权限组合、失败恢复和上下文解释成本。

- 许多跨机器需求直接用 SSH/remote shell 更自然。

- 如果环境本身需要独立插件、权限和执行状态，可以新建另一个 Thread / Agent 绑定对应 Executor。

## 7.2 默认 Container Executor

默认选项采用容器执行器，项目目录 bind mount 到 /workspace。容器内允许 root，以便自由安装 Node、Rust、Go、Python、编译器、调试工具等，而不污染宿主环境。

- /workspace 可读写。

- /tmp 和容器自身文件系统可写。

- 不要默认挂整个 home、~/.ssh、Docker socket 等高风险宿主资源。

- 网络和额外设备能力可由 Executor 配置。

> **设计意图：**容器隔离解决“agent 不要碰宿主其它区域”，Permission 解决“这次 invocation 是否允许执行”。二者不是替代关系。

## 7.3 Host Executor

Host Executor 是一等可选项。对于已经配置好 CUDA、MSVC、Android SDK、硬件工具等复杂环境的用户，直接复用宿主可能更方便。Permission 仍然可以过滤高风险调用。

## 7.4 Profile / Instance / Workspace 的后续方向

Executor Profile → 工具链、插件、默认权限、缓存  
Executor Instance → 活着的容器/进程及临时运行状态  
Workspace → 当前项目文件

v0 不必一次实现复杂的 profile/instance 复用，只需要保证架构允许后续把工具链和项目目录分开。

# 8. 插件体系：Tool Plugin 与 Workflow Plugin 分离

不要把所有扩展都塞进一个万能 Plugin API。讨论中明确拆成两类。

## 8.1 Executor / Tool Plugin

安装到 Executor，负责扩展“现实世界能做什么”。

- read / write / apply_patch

- bash / process

- git

- browser / web interaction

- 特定设备/环境工具

> **设计意图：**Tool Plugin 不决定 agent loop 怎么跑，也不应该负责 project memory、subagent orchestration 等 runtime concern。

## 8.2 Harness / Workflow Plugin

安装到 Agent Runtime，负责改变“agent 如何和世界交互”。

- Permission

- Rolling Context

- Project Context

- Memory

- Goal / Todo

- Subagent orchestration

Workflow plugin 不依赖功能专用 Hook，而通过少数稳定的 Execution Pipeline 语义阶段组合行为。Pipeline 的具体阶段和规则已经在第 21.3 节收敛；后续只在出现真实需求时增加新的语义阶段，而不是为某个插件新增专用入口。

首批真实需求：Permission / Project Context / Memory / Rolling Context / Subagent  
具体扩展点：暂缓定稿，以免为了理论完整性做出过重的 Workflow Engine

## 8.3 Control Tool 与 Executor Tool

模型看到的 tool surface 可以来自两个来源：

- Executor Tool：产生现实副作用，例如 read、bash、apply_patch。

- Control Tool：操作 Harness 自身，例如 delegate、ask_user、checkpoint。

> **设计意图：**Subagent 可以对模型表现成 delegate/spawn_agent 这样的“tool”，但实现属于 Harness orchestration，不应绕进 Executor.execute()。

# 9. Permission 作为独立 Workflow 层

Permission 与 Tool Plugin 分离。Tool 表达 agent-facing capability；Permission 对“具体 invocation”做授权。

model proposes tool call  
↓  
Permission workflow  
allow / deny / ask  
↓  
Executor executes

- 静态 deny：可直接从 agent toolset 中移除。

- 动态 ask / conditional：保留 tool，在 invocation 时拦截。

- 后续 UX 可支持 allow once / thread / project / pattern / deny。

- Permission rule 和审批历史应可解释。

> **设计意图：**不要为了权限粒度把大量底层 capability 暴露给模型。模型主要理解 tool；更细的 effect classification 可以留在 tool/plugin 和 permission 内部。

# 10. Project Context、Memory 与多 Thread 连续性

换 Executor 时应在同一 Project 下新建 Thread。为了避免“新 Thread 突然变笨”，Project Context 必须是一等能力，并且适合做成 Workflow Plugin。

## 10.1 五层状态边界

Memory 跨项目、长期用户/agent 偏好与知识  
Project Context 项目级共享知识、决策、目标、近期状态  
Thread History 当前连续工作上下文  
Thread Execution 当前 agent loop 的 idle / running / paused 状态及未完成 execution  
Executor State 现实执行环境与 tool execution

## 10.2 Project Context 不只是摘要

可以区分：

- Project Facts / Decisions：较稳定的架构、约束、约定。

- Project Activity：近期完成事项、open issues、正在推进的工作。

Project Context plugin 可以自行决定如何从项目资料、历史 Thread、决策记录等来源构造要注入的内容，而不是把所有旧 Thread 原样塞进去。Runtime 只需要展示实际 context/token 消耗，不主动替用户实施预算策略。

## 10.3 写回语义

难点不只在“如何读 Project Context”，还在“谁决定什么应该进入”。这属于 Project Context / Memory 插件策略；可以在 Thread 活动或关键 boundary 后产出候选：

ContextCandidate  
├─ decision  
├─ fact  
├─ unresolved issue  
└─ summary

再进行 merge / supersede / ignore，避免 Project Context 演变成另一个无限增长的聊天日志。

# 11. History / State Sync 与网络拓扑

用户希望在不同设备上保留完整 Thread/Project history，但不希望因此被迫引入中心账号体系。同步应作为可替换 Workflow/State Sync 能力。

## 11.1 同步什么

- Threads / canonical conversation

- Projects / Project Context

- Memory

- 用户设置和允许同步的 plugin state

## 11.2 不同步什么

- Executor-local running execution state / process handle（不跨节点同步）

- Executor credential

- one-shot permission grant

- 本机绝对路径等 environment-local state

## 11.3 不绑定 Tailscale

各组件之间的网络连接不绑定任何单一技术。可以使用 localhost、LAN、公网 IPv4/IPv6、域名 + TLS、反向代理、overlay network 等。

> 设计意图：Topology is deployment configuration, not application semantics. “是不是同一台机器 / 是否 Tailscale / 是否公网”不应该改变 Project、Thread、Message、Agent Loop、Executor 的语义。

# 12. Runtime 可以运行在浏览器，也可以常驻

Harness Core 应是环境无关模块，Browser Host 与 Daemon/Node Host 都可以承载它。默认 UI 可以直接内嵌 Runtime，以获得最简单、低延迟的体验；需要长时间无人值守时，也可以让 Runtime 运行在电脑上的常驻进程。

Browser  
├─ UI  
└─ Agent Runtime  
↓  
Executor  
  
或  
  
Browser UI  
↓  
Daemon Agent Runtime  
↓  
Executor

浏览器被系统杀掉时不需要自动 failover。Thread 进入 paused/suspended 语义即可；下一次打开 UI 后点击 Continue。若 Executor 上的 tool 已完成则读取结果，若仍在运行则继续等待，若 Executor 重启后已丢失则标记 interrupted，并让 agent 检查现实状态。

> **设计意图：**Harness Host 是 disposable run processor，不是状态所有者。复杂的 distributed leader election / 自动接管对个人/小规模场景属于过度设计。

# 13. Subagent 与多环境问题

Subagent 不需要新的 execution 抽象。它可以由一个很薄的 Harness/Workflow 扩展通过现有 Thread 能力创建 child Thread，并为 child 绑定固定 Executor。Main 与 child 都是普通 Thread，各自拥有独立 agent loop，可以真正并行运行。

Main Thread ↔ messages ↔ Child Thread A  
│ │  
agent loop agent loop  
│ │  
Executor A Executor B  
  
spawn_child() 立即返回，不阻塞 Main。

Child Thread 与普通 Thread 使用相同的消息语义：child 可以在探索过程中随时给 main 发消息，main 也可以实时调整 child 的方向。消息到达 running Thread 时成为下一 model step 的输入；到达 idle Thread 时自动唤醒；到达 paused Thread 时只保存。这样得到的是协作式并行 agent，而不是同步 subagent() 函数调用。若 main 与 child 在不同 executor，默认不要依赖共享物理文件系统；后续需要时再增加：

- Workspace snapshot：适合 reviewer/tester。

- Branch / overlay：适合 child 修改代码后返回 patch/commit。

- Artifact transfer：适合脚本、日志、测试报告、build output。

> **设计意图：**这些不是 v0 必须完成的能力。大多数跨环境动作可以先通过 SSH/remote tool 完成；不要为了理论上的分布式场景过早复杂化核心。

# 14. 仍需进一步设计的关键 Harness 问题

在删掉 Run/Intent、复杂 process manager、tool reconcile、过重 workflow pipeline 等非必要抽象后，真正需要在 Harness 层继续明确的问题已经明显减少。以下只保留会影响长期语义边界的问题；具体数据库、网络库、UI 控件等实现问题不在此列。

## 14.1 Canonical Thread History 与 Execution Log 的边界

- 明确哪些语义对象进入 canonical Thread history：用户/agent 消息、committed assistant output、tool call/result、interrupted 结果等；provider retry、网络 timeout、UI reconnect 等只进入 execution/debug log。

- 明确 model step 与 Tool Batch 的 durable commit 边界，使 Runtime 重启后可以确定地继续 Thread agent loop，而不会制造重复 assistant/tool history。

- 持久层具体采用 event log、状态表或二者结合属于实现选择；早期优先允许数据迁移和 breaking change，不为旧 schema 长期保留 runtime compatibility。

## 14.2 Core Context 的最小保证与插件边界

Core 不规定模型最终必须看到哪些内容。Canonical History、Tool 结果、恢复提示、Executor tool schemas 等只作为可供 projection 使用的事实/建议来源；真正进入 model context 的内容由 context projection 与插件决定。这样可以让 rolling context、project context、memory 等策略自由演化，而不把某一种上下文策略固化成 Harness 语义。

Runtime 只需要可观测地展示 context/token 消耗。预算不足时不应自动裁剪或替用户关闭插件；真正撞到 provider/context limit 时进入与 Pause 同类的暂停状态，由用户调整模型、插件或 compact 后 Continue。

## 14.3 Model Adapter 的最小公共语义

- Model Adapter 保持薄层抽象。第一版优先支持事实标准最广的 OpenAI-compatible 接口；Core 只需要统一完整 model step、0..N tool calls、streaming partial output、usage/metadata 等最低公共语义。Anthropic 等其它协议可按实际需求增加 adapter，不要求 v0 建立 provider zoo。

- 并行 tool calls 是 core 能力；partial streaming 在完整 model step 成功前不进入 canonical history。Provider-specific reasoning/usage 可以保留为可选 metadata。

- Provider retry、协议差异和特有字段尽量停留在 adapter/execution log 层，不应污染 Thread 的通用历史语义。

## 14.4 Tool / Executor 最小协议

- Runtime 与 Executor 的核心交互保持很薄：获取 tool schemas、提交并发 Tool Batch、查询 execution 状态/结果、请求 Interrupt。Executor 的发现和连接不作中心化假设：可以自动发现，也可以由用户手动启动后填写 endpoint 连接。

- interrupted 是标准终态之一，表示 execution 未正常完成且现实副作用未知。恢复时由 projection 向 agent 提供检查现实状态的提示；不要求通用 tool 实现可靠 reconcile。

- 普通子进程属于 tool 生命周期；显式 spawn/detach 后成为普通系统后台进程，不在 Harness Core 额外建模。Terminal/PTY 的具体 UX 可以后置。

- Artifact / workspace file 的更丰富模型可后置，直到真实跨 executor / 文件传递需求出现。

## 14.5 Workflow Plugin 的最小扩展边界

- 插件在用户理解上仍可区分 Tool Plugin 与 Workflow Plugin，但底层使用统一 Plugin API。Workflow Plugin 通过 Execution Pipeline、Commands、UI 等语义面组合行为；Pipeline 的稳定阶段和修改规则见第 21.3 节。

- Permission、Project Context、Memory、Subagent 等插件都应优先落在既有 Pipeline/Tool/Command/UI 语义面上；只有现有稳定阶段无法表达真实需求时，才新增新的 Pipeline stage。

- 插件可以影响给模型看的 projection 或 Runtime 行为，但 canonical history 是不可修改的事实依据，只能作为 projection 的 source。插件若需要记录自己的事实，只能追加 canonical logger record 或维护自己的 plugin state。

## 14.6 尚未进入核心语义、可后置的问题

- Secrets/credentials、artifact store、sync transport、terminal UI、container cache、remote executor transport、plugin migration 等先按实现需要推进。

- Observability 仍值得做：至少显示 token/context 消耗、tool/model 状态，并保留“模型最终实际看到什么”的 Projection View。

- 更完整的 replay/debug 可以后补，不应反过来扩大 Core 状态模型。

# 15. 建议的 v0 Vertical Slice

为了防止无限扩展概念，v0 应优先验证核心语义，而不是追求 feature parity。

1\. 单个 Project，可以选择本地目录。

2\. Thread 创建时固定选择 Executor。

3\. Container Executor 作为默认，Host Executor 作为可选。

4\. 基础 tools：read / write 或 apply_patch / bash / git status-diff。

5\. Runtime 支持多 Thread agent loop、并行 Tool Batch、pause / continue / interrupt；running Thread 中的新消息自然成为下一 model step 的输入。

6\. Tool 有 execution_id；Executor 能报告 running/completed/failed/interrupted，并支持显式 interrupt。

7\. canonical Thread history 与 execution/debug log 分离；网络/provider/UI 故障不污染对话历史。

8\. 最小 Permission workflow：allow / deny / ask。

9\. 最小 Project Context plugin：项目说明 + 决策/摘要注入。

10\. Web UI：Thread list、conversation、tool card、thread execution state、permission dialog、executor indicator。

暂时不需要：复杂 subagent task/result/join 抽象、P2P sync、自动 failover、GPU/VM executor、完整 IDE 文件树、插件市场、通用 provider zoo。若要做 subagent，优先用“创建 child Thread + thread messaging”的最小方式验证。

# 16. Architectural Invariants（实现时优先保护）

- Failures pause or interrupt execution; they do not rewrite canonical Thread history or silently discard the user’s unfinished work.

- Harness reports execution truth instead of guessing side effects; interrupted tool executions are surfaced to the model, which checks the real environment before proceeding.

- Thread/execution state is durable enough to Continue after Runtime/UI loss; Runtime hosts/controllers are disposable.

- Steer is not a special core object: it is an ordinary message sent to a running Thread and becomes visible at the next model step.

- A Thread binds to exactly one Executor for its lifetime.

- Changing execution environment means creating another Thread in the same Project, not mutating the current Thread.

- Executor plugins extend what can be done; Harness workflow plugins alter how the agent interacts with those capabilities.

- Permission governs concrete tool invocations and remains independent of the Executor backend.

- Project Context provides cross-thread continuity; Thread history should not be abused as project memory.

- UI, Runtime, Executor, Store, and Sync are logical roles, not fixed deployment processes.

- Network topology is deployment configuration, not application semantics.

- Prefer migration and clean breaking changes over accumulating runtime compatibility layers during early development.

> **实现指导：**当实现遇到本文未覆盖的新需求时，应先问：它属于哪一层？它是否破坏 Thread→Executor 固定绑定、Conversation/Execution 分离、Tool/Workflow Plugin 分离或 durable resume 语义？如果破坏，应优先重新检查需求和抽象，而不是增加特殊 case。

| **讨论节点**    | **观察**                                    | **形成的设计意图**                                                                                  |
|-----------------|---------------------------------------------|-----------------------------------------------------------------------------------------------------|
| 起点            | Pi TUI 交互不顺，考虑 Web UI 或重写。       | 最初问题看似 UI，但继续分析发现 session、permission、plugin 也存在结构性摩擦。                      |
| Session         | Pi session tree 会记录网络错误。            | 决定将 canonical conversation 与 run/attempt/execution log 分离；网络错误不是用户语义历史。         |
| 恢复            | 网络错误、Stop、浏览器被杀都会中断工作。    | 决定把 intent 做成 durable、可继续；失败只终止 attempt。                                            |
| Tool            | 某些 tool 有真实副作用，不能盲重试。        | 把一致性责任下沉 Executor/Tool；引入 execution_id 与 reconcile。                                    |
| Steer           | 如果 loop 可恢复，steer 不需要复杂 branch。 | 把 steer 定义为对 active intent 的约束更新，在安全 boundary 生效。                                  |
| Executor        | 最初考虑 agent 访问多个 executor。          | 发现很多场景 SSH 更自然，多 executor 会制造 workspace/权限/上下文复杂度，因此固定 Thread→Executor。 |
| 多端            | 希望手机、电脑、服务器统一体验。            | Executor 被重新定位为受控 tool host；UI/Runtime 可部署在任意设备。                                  |
| 插件            | Pi 插件能力有限且不同关注点混合。           | 拆成 Executor Tool Plugin 与 Harness Workflow Plugin。                                              |
| Project Context | 换 executor 需要新 thread，但不能失忆。     | Project Context 成为跨 Thread 连续性的 workflow plugin。                                            |
| 同步            | 希望多设备保留历史但不想做账号。            | State Sync 独立，不绑定账号/Tailscale/中心服务器。                                                  |
| 默认环境        | 容器内 root 配工具链更干净。                | Container Executor 成为默认；Host Executor 保持一等选择。                                           |

# 17. 进一步收敛后的统一模型与设计意图

这一轮讨论的主要价值不是增加更多机制，而是持续删除 Harness 不必理解的高层概念。目标是让 Core 只负责可靠地推进 Thread、传递消息、调用模型和 Executor，把“任务到底意味着什么”尽可能留给模型与可选插件。

## 17.1 Message 是统一的协作入口

Steer 不再是特殊事件，也不要求 Intent revision。用户、main agent、child agent 给 Thread 的输入都可以统一成 Message。区别只来自 Thread 当前 execution state：running 时消息在下一 model step 可见；idle 时消息会启动 agent loop；paused 时只持久保存，直到用户 Continue。

- 这样得到一个非常优雅的结果：Harness 不需要同时维护“普通消息、steer、subagent result、resume hint”等多套相似对象，消息历史也更接近模型真实看到的协作过程。

## 17.2 Subagent = Child Thread + Messaging

Subagent 调用应当是非阻塞的。spawn child 后 control tool 立即返回，main 继续自己的 agent loop；child 在独立 Thread 中并行工作，并可随时向 main 发消息。main 也可以在 child 工作途中继续给它发消息调整方向。

- 如果 main 当前没有别的有意义工作，它可以自然回到 idle；child 后续消息到达时会再次唤醒 main。无需 await/join/waiting_for_subagent/SubagentResult 等专用状态。

- 这样得到的不是“同步函数式 subagent”，而是真正可双向沟通、可并行推进的协作式 agent。Child Thread 也无需额外 execution 抽象，只需要少量 thread-management / messaging tools。

## 17.3 并发边界

一个 Thread 在任意时刻最多只有一条 active agent loop，但一个 Runtime 可以同时推进许多 Thread，一个 Executor 也可以同时执行来自不同 Thread 的多个调用。一次 model step 产生的多个 tool calls 构成一个 Tool Batch，Batch 内并发，全部 settled 后作为一个集合交给下一次 model step。

- 这既保留了单 Thread 历史的线性和可理解性，又允许 explore/read/subagent 等真实工作获得充分并行性。

## 17.4 Pause / Interrupt / Executor Crash

Pause 只阻止下一步继续推进，不隐式终止当前 tool。Pause 后若 tool 仍在运行，UI 再提供明确的 Interrupt 操作。Executor 如果在 running tool 尚未完成时崩溃，持久状态先保持 running；Executor 重启后确认 execution 已丢失时，再转为 interrupted。

- interrupted 不依赖 tool 自己做可能不可靠的 reconcile。下一次 model context 明确告诉 agent：该调用没有确认完成，现实状态可能部分改变，先检查环境再继续。这样 Harness 只陈述事实，不伪造现实世界的一致性。

## 17.5 后台进程保持简单

不为所有长期进程引入独立 Resource/Process Manager。普通子进程属于 tool 生命周期；明确 spawn/detach 的任务在启动成功后就是普通系统后台进程，可以在 Runtime/UI 关闭后继续运行，后续通过 ps/kill/日志等普通工具管理。

- 这样避免 Harness 演化成进程编排平台，同时仍覆盖开发服务器、watcher、SSH tunnel 等真实场景。

## 17.6 Token 与 Context 策略保持用户可见、不过度代管

Runtime 负责显示 context/token 消耗，但不自动替用户设置复杂预算，也不因为某个插件“费 token”而擅自裁掉内容。用户可以自行关闭昂贵插件；真正撞到 provider/context limit 时，把 Thread 置为 paused，用户调整模型、插件或手动 compact 后 Continue。

- 这避免 Core 内建一套难以预测的“智能降级”，也让 context 成本保持透明。

# 18. 当前仍未定稿的 Harness 级问题

经过上述收敛，剩余问题已经从“设计一个完整工作流平台”缩小为少数真正影响长期行为语义的边界。

- Canonical history 已明确作为不可修改的事实依据；它记录已提交的 Message、完整 model step、tool call/result 等事实，网络波动、retry、UI 断连等运行细节进入 execution/debug log。剩余仅需实现时确定具体 record schema。

- Model step / Tool Batch 的 durable commit 规则已基本确定：完整 model step 成功后才 commit；若其产生 Tool Batch，则该组 tool 并发执行并全部 settled 后一起进入下一 model step。Runtime/Executor 之间使用稳定 execution_id，重复提交同一 id 必须去重，避免网络波动造成重复副作用。

- Core 不承诺固定的 model context 内容。Canonical facts 作为 projection source，context policy 由插件决定；Core 只需提供足够结构化的事实和建议字段，不替插件决定最终投影。

- 插件系统方向已收敛：同一 Plugin API 可注册 tools、参与 Execution Pipeline、读取/追加 Canonical Logger、使用 Plugin State。Tool plugin 只是主要注册 tool；Workflow plugin 主要参与 pipeline，但也可以注册 tool。Pipeline 的 v0 阶段与组合规则已经确定，见第 21.3 节。

- Model Adapter 第一版以 OpenAI-compatible 为主，保持最低公共语义，不预先为不常用 provider 设计复杂兼容层。

- Executor 不要求 Core 判断“逻辑上是否还是同一个环境”。Runtime 只维护用户选择/连接的 endpoint 与 Thread binding；断线、手动重连、环境变化都属于用户可控部署行为。

近期收敛：从“Run / Intent / Steer / Subagent Task / Process Resource”等多个专用抽象，进一步收敛到“Thread + Message + Agent Loop + Tool Batch + Executor”。设计动机是减少 Harness 对任务语义的自作主张，让同一套消息与执行机制自然覆盖用户 steer、恢复、main/child 协作和并行工具调用。

# 19. 最近收敛的状态、消息、执行与插件边界

本节补充后续讨论中已经确认、但此前文档尚未完整记录的设计。继续遵循“保存事实，不替模型维护不必要的高层语义”的原则。

## 19.1 Message 在安全边界进入下一轮模型调用

Thread 正在 model/tool execution 时，新 Message 可以立即持久化，但不会穿插进正在执行的 Tool Batch，也不会隐式 Interrupt。它只会在下一次安全边界进入新的 model projection。Tool Batch 因而仍是一个完整的 model-step 单元：一组 tool 并发执行、全部 settled，再把新消息与完整结果一起交给下一 model step。

- 设计原因：真实到达时间和模型可消费顺序是两回事。这样可以避免 tool result 与用户消息交错破坏 provider 的 tool-call/result 结构，也让网络与并发行为更可预测。

## 19.2 Thread 不需要 completed；状态由事实派生

Thread 可以长期存在并反复 idle → 收消息 → 工作 → idle，不需要显式 completed 状态。Core 保存 paused 意图以及当前 active executions，UI 状态从这些事实派生：无 active execution 且未 pause 为 Idle；有 active execution 且未 pause 为 Running；有 active execution 且 pause 已请求为 Pausing；无 active execution 且 pause 为 Paused。

- Pause 是 Thread 级持久控制意图；Interrupt 是 execution 级命令。Pause 不停止当前 tool/model execution，只阻止到达安全边界后继续推进。这样避免为了每个暂时条件不断扩充 Thread 状态枚举。

- Subagent 场景中，Pause 向 child lineage 传播是很合理的默认体验，但该行为可以由 subagent/workflow plugin 实现；Core 只需允许这种兼容方式，不必直接内建复杂的 pause-reason 传播模型。

## 19.3 Execution 最小状态与网络波动语义

Model/Tool execution 共用最小状态：pending、running、completed、failed、interrupted。pending 必须保留，因为 Runtime 与 Executor 之间存在真实网络边界：execution 已 durable 创建但尚未确认底层开始时，需要能够被准确表达。

- completed 表示完整结果已经被接受并持久化；failed 表示确定地失败；interrupted 表示没有正常完成且现实副作用未知。

- Executor 暂时 unreachable 不改变 running 状态。只有 Executor 重启后明确确认旧 execution 已不存在，或用户明确将无法确认的 execution 标记为 interrupted，才进入 interrupted。

- Interrupt request 本身不是 execution 状态；请求可能最终得到 completed 或 interrupted，Core 记录最终事实。

- Model streaming 的 partial output 仅是 transient；完整 model step commit 前 Runtime 消失，则这次 model execution 被视为未完成，不把半截 assistant output 写入 canonical history。

## 19.4 Execution 与 Message 都使用稳定 ID 去重

网络波动下必须避免“ACK 丢失导致重复副作用”。Runtime 可以重复提交同一个 execution_id，Executor 必须把同一 ID 视作同一次逻辑 execution，并返回已 pending/running/completed 的现有事实，而不是再次执行。

- Message 同理应拥有稳定 message_id；发送 ACK 丢失后重复发送同一 ID 不应产生重复消息。Thread canonical store 负责给已接受消息建立唯一逻辑顺序，不依赖客户端 timestamp 做事实排序。

- 这样无需追求分布式 exactly-once，却能在最关键的网络边界获得幂等提交语义。

## 19.5 Child Thread 完全复用普通 Thread

Child Thread 不引入专用 SubagentTask/Result/Join 抽象。它就是普通 Thread，加少量 metadata（如 parent_thread_id / created_by_agent），默认属于与 parent 相同的 Project。UI 可以默认折叠或隐藏，但用户仍然可以打开它并直接发 Message。

- 设计结果：main 与 child 可以真正双向、实时协作；child 的结果不是同步返回值，而是普通 Message。由于没有额外抽象成本，用户未来也可以直接介入某个 child Thread，而不需要新增特殊 UI/协议。

## 19.6 Tool 对 Agent 暴露语义描述，而不是实现来源

Agent-facing tool schema 不需要显式 source/kind 字段来说明来自 Harness、Executor 或插件。内部 routing 属于实现细节。真正重要的是 tool description 必须清楚说明作用对象、同步/阻塞语义以及对 Harness 的影响。

- 例如 send_message 应说明“向另一个 Thread 发送消息且不等待对方完成”；question 若启用，应说明“阻塞当前 Tool Batch/agent loop，直到用户回答”。这样模型按语义使用能力，而无需理解内部架构。

## 19.7 Question 不是默认能力

Question 应当只是一个可选的阻塞 tool，而不是 Harness 内建的人机交互原语。喜欢脱手自动化的用户可能完全不安装它；若只需要非阻塞地向用户表达疑问，Agent 直接输出文本即可，用户看到后用普通 Message steer。

- 设计原因：非阻塞 question 本质上只是 conversation output 的包装，会破坏 tool“提供实际能力或明确同步语义”的边界。阻塞式 question 则可以像任何其他 tool 一样自然等待结果。Subagent 是否暴露 question 可由其 workflow/plugin 配置决定，Core 无需特殊处理。

## 19.8 Canonical History = 不可修改的事实源；Canonical 只需 Logger

Canonical history 不需要做成可组合 pipeline。它本质上是 append-only Logger / fact store：记录已经发生并 commit 的事实，供 sync、debug、projection 与审计使用。插件不能修改或删除既有 canonical records。

- 插件可以读取/订阅 canonical records，也可以追加自己的 namespaced durable record（例如 permission decision、projection generated），但这些同样一旦写入就不可修改。可变的工作状态应放在 Plugin State，而不是伪装成历史事实。

- 这样得到一个非常清楚的关系：History 是事实，Projection 是解释；rolling context、project context、memory 等可以自由改变模型视图，而不会污染事实依据。

## 19.9 Core 不决定 Context 内容

Core 不保证模型一定看到哪一组历史、恢复提示或 Project Context。它负责提供结构化事实与可供使用的建议字段；最终 Context Projection 完全由插件/配置决定。Token 使用透明展示即可，是否关闭高成本插件由用户选择。

- 这样可以避免 Core 内建一套“正确上下文”的假设，也让不同用户可以实验极简 history、rolling projection、project memory、goal 等完全不同的工作流。

## 19.10 Executor 连接而非身份认证是核心问题

Runtime 不能假定总能自动发现 Executor。用户可能手动启动本机 Executor 后连接 localhost，也可能填写 LAN、公网 IP、域名或其它 endpoint。Core 不需要验证重新连接的环境“逻辑上还是不是同一个 Executor”；是否复用 endpoint/配置是用户自由。

- 这样把 Executor identity 从一种强语义承诺降成连接/配置问题，避免为了环境变化引入不必要的身份迁移机制。

## 19.11 插件系统当前收敛方向

插件仍可在用户理解上分为 Tool Plugin 与 Workflow Plugin，但底层不需要互斥类型。Tool Plugin 主要注册 tool；Workflow Plugin 主要参与 Runtime Execution Pipeline，同时也允许注册 tool。

- Canonical 事实记录不进入可修改 pipeline，而直接通过 Canonical Logger 完成。插件 API 因而可以围绕四类能力收敛：注册 tools、参与 execution pipeline、读取/追加 canonical logger、维护 plugin state。

- 设计结果：不会依赖 Harness 作者恰好预留某个功能专用 hook；主要语义位置本身是可组合 pipeline，Permission、Project Context、Rolling Context、Goal、Subagent 等可以按需插入。具体阶段与修改规则见第 21.3 节。

在上述更新后，Core 级语义基本闭环。Execution Pipeline 也已经收敛为少数稳定语义阶段；其设计目标是在保持开放性的同时避免插件依赖内部实现或反向改写 canonical facts。

# 20. 插件能力面与 UI / Command 扩展

后续讨论进一步确认：Workflow Plugin 不应只被理解为“修改 Runtime 的插件”。真实工作流往往同时包含 Runtime 行为、用户命令和 UI 呈现，因此插件系统需要覆盖这些语义面，但仍避免把插件拆成互斥的技术类型。

## 20.1 一个插件可以向多个语义面贡献能力

底层只有一种 Plugin。所谓 Tool Plugin 与 Workflow Plugin 只是使用习惯上的分类：前者通常主要注册 Tool，后者通常主要参与 Execution Pipeline，但 Workflow Plugin 同样可以注册 Tool、命令或 UI 贡献。这样不会因为“插件类型”限制一个完整工作流必须被拆成多个互相耦合的包。

当前确认的插件能力面包括：Tools、Execution Pipeline、Commands、UI Contributions、Plugin State 与 Canonical Logger。它们分别对应“增加 Agent 能力”“改变 Runtime 行为”“增加用户显式操作入口”“改变呈现与交互”“维护可变插件状态”“追加不可变事实记录”。

设计结果：插件不是一组作者预先猜好的功能 Hook，而是对少数稳定语义面的贡献集合。未来新增 Workflow 时，优先组合这些语义面，而不是要求 Core 为每一种功能单独增加专用 API。

## 20.2 Slash Command 是用户动作入口，不应伪装成普通 Message

Workflow Plugin 可以注册 / 开头的命令。Slash Command 的语义是用户显式调用一个本地或工作流动作，它未必需要进入模型上下文，也未必应该形成 canonical user message。例如 /compact、/permissions、/agents、/executor 等操作都可能只修改插件状态、打开 UI、调用 Runtime API 或执行某个控制动作。

因此命令应走独立 Command Registry / Router：普通文本仍按 Message 进入 Thread；命中 Slash Command 时由插件 handler 处理。这样避免让 Agent 自己解析 Harness 控制命令，也避免把纯本地操作污染成对话事实。

Command 本身应带名称、描述等语义 metadata，使同一注册项可以同时用于 slash 自动补全、Command Palette、移动端 Action Sheet 或帮助页。Slash 只是其中一种输入方式，而不是命令能力的唯一 UI。

## 20.3 UI Contribution 应开放语义位置，而不是内部组件树

Workflow Plugin 可以改变 UI，但不应依赖 DOM、Vue/React 组件树等具体实现细节。UI 应提供稳定的语义 extension points，例如 Thread toolbar、composer actions、sidebar/panel、status area、settings、message decoration、tool result renderer 等。

设计原因与 Runtime Pipeline 相同：开放“这个位置代表什么”，而不是开放“当前代码怎么组织”。这样 UI 可以重构或在桌面、手机、Web 上使用不同实现，而插件仍能表达同样的工作流。

Tool-specific renderer 也应是可选贡献。没有自定义 renderer 时，UI 使用通用 Tool Card；插件可以额外为 apply_patch、permission、subagent 等提供更合适的 diff、approval 或 child-thread 展示。这样工具能力不依赖特定 UI 才能工作。

## 20.4 插件包不能假定 UI、Runtime、Executor 在同一进程

整个 Harness 的逻辑角色已经明确分离，因此插件设计也不能默认所有代码总在同一位置运行。一个插件可以概念上包含 Runtime contribution、Executor contribution 与 UI contribution；具体是否在 v0 就拆成多个 bundle/entrypoint 可以以后实现，但协议设计不能依赖“插件代码一定和 UI/Runtime 同进程”。

例如 Permission Workflow 可能在 Runtime 的 tool invocation pipeline 做决策，同时在 UI 提供 approval dialog 与 /permissions 命令；apply_patch 的 Tool 实现在 Executor，而 UI 可以额外提供 diff renderer。这样同一工作流可以跨部署拓扑保持一致。

## 20.5 Canonical Logger 与 Execution Pipeline 保持正交

Canonical 不需要被抽象成 Pipeline。它就是 append-only Logger / fact store：Execution Pipeline 决定系统接下来怎么运行，Canonical Logger 记录已经发生了什么。插件可以读取、订阅并追加自己的 namespaced durable records，但不能修改或删除已经 commit 的事实。

可变的插件内部状态放在 Plugin State。Canonical record 用于审计、debug、sync 与 projection source；Plugin State 用于 goal.current、permission rules、memory index 等会被覆盖和更新的数据。把两者分开，可以避免“当前状态”和“历史事实”相互污染。

## 20.6 插件 API 的当前最小形状

在不提前锁死具体接口形式的前提下，当前设计可以概括为以下能力集合：

- tools：注册 Agent 可调用能力；

- pipeline：在稳定的 Runtime 语义阶段组合、包裹或替换行为；

- commands：注册用户显式动作与 slash / command-palette 入口；

- ui：向稳定的 UI semantic slots 贡献呈现与交互；

- state：维护插件自己的可变持久状态；

- canonical：读取/订阅 canonical facts，并追加插件自己的不可变记录。

这六个能力面不是六种插件。一个插件可以只使用其中一个，也可以同时使用多个。设计目标是让完整 Workflow 可以在一个包里自然表达，同时又不要求插件直接碰 Harness 内部实现。

# 21. 当前设计是否已经能构成可用 Harness

从“是否足以构成一个可以长期日用的 Harness”而不是“是否覆盖所有高级功能”的标准检查，目前主体结构已经闭环。核心已经回答了 Agent 如何被推进、事实如何记录、工具如何并发执行、网络波动如何恢复、Thread/Executor 如何绑定、用户与 Agent/Child Agent 如何通信、插件如何改变工作流以及 UI/Runtime/Executor 如何独立部署。

## 21.1 已形成完整体验闭环的主要结构

- Project 提供多 Thread 的共享工作边界；Project Context / Memory 等高层能力可以由插件实现。

- Thread 是长期存在的协作上下文，没有 completed 状态；同一 Thread 最多只有一条 active agent loop。

- Message 是统一输入机制：用户 steer、普通后续输入、child agent 反馈都不需要额外核心抽象。

- Thread 状态由 pause 意图与 active execution 事实派生；Pause 与 Interrupt 分离。

- Model/Tool Execution 具备 pending、running、completed、failed、interrupted 最小状态，适配不可靠网络。

- 一次 Model Step 产生的 Tool Calls 形成并发 Tool Batch，全部 settled 后一起进入下一安全边界。

- Executor 与 Runtime 分离；一个 Runtime 可以连接多个 Executor、推进多个 Thread，而每个 Thread 固定绑定一个 Executor。

- 默认 Container Executor 提供隔离和可复用工具链，Host Executor 作为一等可选项。

- Subagent 复用普通 Child Thread 与 Message，实现真正并行、双向、可由用户直接介入的协作。

- Canonical History 是不可修改事实依据；Projection 可以自由基于事实构造模型上下文。

- Plugin 通过 tools / pipeline / commands / ui / state / canonical 等语义面构成完整工作流。

- UI 只是交互客户端；Runtime 可以嵌入 UI，也可以独立常驻；Runtime 消失时 Thread 可以暂停并恢复。

- 网络拓扑不绑定 Tailscale、账号或中心服务器，可按 localhost、LAN、域名、公网等方式部署。

这些结构已经足以支持一个完整的“创建 Project → 新建 Thread → 选择 Executor → 发消息 → Model/Tool 循环 → Pause/Interrupt/Continue → Child Thread 并行协作 → 跨设备继续查看与控制”的日常体验。

## 21.2 没有明显缺失的核心结构，但仍有几类产品能力需要实现

目前没有发现必须再新增一个核心领域对象才能让 Harness 成立的明显缺口。剩余事项更多属于能力实现或插件策略，而不是新的 Core Architecture。

- Executor/Runtime 连接与认证的具体协议、发现方式和手动连接 UX；

- 模型配置、Provider Adapter、usage 展示与模型切换 UX；

- Project Context、Rolling Context、Memory、Goal 等 Workflow Plugin 的实际策略；

- Permission Plugin 的规则与审批 UI；

- State Sync 的实现与冲突处理；

- Secrets/credentials 的实际存储与注入方式；

- Terminal、diff、tool card、child thread 等 UI 打磨；

- 插件安装、启停、更新、配置与多 entrypoint 打包方式。

这些内容都可以在现有边界内逐步增加，不要求改写 Thread / Message / Execution / Executor 等基础语义。若后续出现新需求，应优先判断它能否通过 Tool、Pipeline、Command、UI Contribution 或 Plugin State 表达；只有无法表达时才考虑扩展 Core。

## 21.3 Execution Pipeline：稳定语义阶段与组合规则

Execution Pipeline 不以具体插件功能命名，而以 Harness 本来就存在的领域操作作为稳定阶段。这样插件能力不依赖作者是否提前猜中了某个功能专用 Hook，同时避免把当前函数结构固化成公共 API。

v0 只保留五个主要阶段：step、projection、model、toolBatch、toolInvocation。未来若真实需求证明某个阶段过粗，可以继续增加语义子阶段；增加阶段是兼容性的扩展，不要求提前枚举几十个 before/after Hook。

### 21.3.1 step

step 表示一次 agent-loop iteration 的最外层语义边界：构造本轮 projection、调用 model、处理本轮可能产生的 Tool Batch，并最终到达下一个 safe boundary。它适合那些需要影响“这一轮是否以及如何继续”的 Workflow，例如 Goal 或特殊循环控制。step 不代表新的 Run/Intent 对象；Thread 仍只有一条 active agent loop。

### 21.3.2 projection

projection 从 Canonical History、当前 Thread/Executor 可用信息以及插件自己的状态中生成本次 Model Input。Canonical History 只是事实 source，不等于模型上下文；Rolling Context、Project Context、Memory、Goal 等都可以在这里改变、压缩、替换或补充 projection。Core 不承诺任何固定内容一定进入模型。

### 21.3.3 model

model 表示 Model Input → Model Output 的完整调用语义。Model router、fallback、cache、usage 统计、provider 适配等可以包裹或替换这一阶段。Streaming partial output 仍只是 transient；只有完整 Model Step 成功后才会成为可记录的 committed fact。

### 21.3.4 toolBatch

toolBatch 接收一次 Model Step 返回的整组 Tool Calls。默认行为是并发进入各自的 toolInvocation pipeline，并等待所有成员进入 terminal state 后形成一个完整 Batch Result，再交给下一次 Model Step。单个工具失败或 interrupted 不会使 Harness 擅自回滚其它工具；Harness 只如实返回整批结果。该阶段可以被用于整批调度、并发上限或 tracing，但不负责单个工具的授权细节。

### 21.3.5 toolInvocation

toolInvocation 表示单个 Tool Call → Tool Result/Execution terminal state。Permission 最适合在这里实现，因为同一批次中的不同 Tool 可以得到不同授权结果。Audit、rate limit、tool-specific wrapper 等也可放在这里。Executor Tool 与 Runtime/Control Tool 对 Agent 可以共享普通 Tool surface；内部如何 routing 属于实现细节。

### 21.3.6 Pipeline 的组合能力

Pipeline interceptor 可以读取和修改尚未 commit 的输入/输出，也可以 wrap 默认行为、short-circuit 或完全 replace 默认实现。这样 Workflow Plugin 真正能够改变工作流，而不是只能被动收到通知。是否调用 next() 由 interceptor 决定；v0 不需要为了“安全”把插件降级成只能观察的 Hook。

纯观察不需要独立的插件体系。统计、usage、logging 等插件可以在对应 Pipeline 上只读地包裹行为；未来若只读观察非常常见，可以增加 tap/on convenience API，但它只是便利接口，不形成新的插件类别。

同一 stage 上多个 interceptor 的顺序属于显式配置/注册顺序问题；Core 应保证顺序确定且可观察，但不需要为每类插件预设固定优先级。插件若对顺序有强依赖，应显式声明或由用户/插件管理层配置，而不是依赖偶然加载顺序。

### 21.3.7 Canonical Logger 与 Pipeline 的边界

Execution Pipeline 只影响尚未成为事实的未来行为；Canonical Logger 记录已经发生并 commit 的事实。插件可以读取/订阅 canonical records，也可以追加自己的 namespaced immutable record，但不能通过 Pipeline 回头修改、删除或伪造既有 canonical facts。可变的插件工作状态继续放在 Plugin State。

设计结果：Harness 不需要为 Permission、Memory、Project Context、Goal、Subagent、Usage 等逐个预留专用 Hook。它只需要维护少数稳定的领域 Pipeline；新的 Workflow 优先通过这些阶段、Tool、Command 和 UI Contribution 组合完成。只有真实需求无法表达时，才增加新的语义 stage。这样既保持了非常开放的插件能力，又避免插件 API 与 Harness 内部函数结构强耦合。

# 附录 A. 设计演化脉络

这部分刻意保留讨论过程中的“为什么”，便于以后判断一个新功能究竟符合还是背离原始方向。
