# 执行、事实与 Provider 边界重构 v1

状态：2026-10-20 用户授权设计后分阶段实现；2026-10-21 完成 A1-A20 首轮实施与独立验收。用户随后要求补充不依赖 Rolling Context 的 Runtime compact fallback，S6 已实现并完成验证。本文为实施契约、验收清单与验证记录；改动尚未提交或部署。

## 1. 不变量

1. 每个 Thread 至多一条 Runtime 管理的 agent loop。插件通过既有 step / projection / model / toolBatch / toolInvocation 改变未来行为；Runtime 独占 Execution 生命周期、恢复、最终提交。插件不能直接终结任意 Execution。
2. Child 是普通 Thread，仍走同一实现。摘要/Reviewer 是有用途和归属的单次模型操作，复用模型调用实现，不拥有另一套 Thread loop、Tool Batch 或普通 Assistant 提交逻辑。
3. Canonical 是会话与工作流事实的唯一可信来源。Execution、Thread 控制状态、Plugin State 和辅助模型结果索引是物化视图；诊断日志不用于恢复，不得因其写入失败改变执行结果。
4. 配置连接、凭据、会话认证和可丢缓存不属于会话事实。密钥永不进入 Canonical、模型选择或诊断；需要独立私有存储。Project/Executor 身份与连接配置不是本次全库事件溯源工程，工作流重建保留它们。
5. Canonical 原有记录不能修改；旧视图中独有数据通过带版本的 `legacy-import` 现状快照追加，不冒充过去发生的事件。
6. Settings 的 Memory 是 Global Memory；Project Memory 只在 Thread toolbar。不新增 Global/Project 统一管理页。
7. 不新增 Run/Task/Profile 管理系统或 provider pipeline stage。Provider 分发是既有 model stage 的终端能力。

## 2. 事实与当前态

在现有 Canonical 存储上增加有版本、类型和作用域的内部事实记录。与普通 message/assistant/tool_result 分开识别；内部工作流事实不进入普通消息 Projection、UI 对话卡片或 Tool Batch 分段。

作用域支持 Thread 与非 Thread（插件/Project/Global）事实；非 Thread 事实必须有稳定顺序、唯一 ID、明确作用域，不能产生重复 seq 或将 null 解析成字符串。保留现有 Thread 消息 seq / projectionThrough 的含义。

优先使用通用、版本化的状态快照事实作为本轮最小可重放格式，而不为每个业务插件在 Core 编写 reducer：

- Execution 创建/状态/结果事实 -> executions 物化视图。
- Thread Pause/Resume 控制事实 -> pause_requested / pause_reason。
- 命名空间 Plugin State 变更事实（pluginId/key/value/revision）-> plugin_state。
- Thread ModelSelection 变更事实 -> Thread 模型选择视图。
- 辅助模型调用开始/终结、幂等身份和结果事实 -> plugin_model_calls 兼容查询视图。

插件业务快照格式版本归通用状态契约管理，插件审计事件可额外说明原因。写事实与更新视图必须在一个事务内；通知在提交后发出。跨多个状态键/审计记录的业务操作使用显式事务。重放只读事实，不能再发模型请求、执行工具、触发插件审计或改变远端副作用。

提供明确的工作流视图重建入口，恢复上述状态而不依赖 execution_log；测试比较重建前后业务状态。凭据使用独立私有接口/表；ChatGPT OAuth state 必须在开启通用状态事实化前迁出普通 Plugin State。模型目录等缓存可有明确 cache 接口，不能成为推进或幂等事实来源。

生命周期的权威记录进入 Canonical。execution_log 剩余内容属于 best-effort 诊断；请求输入预览缺失时界面可显示缺失。失败/重试/usage 等需要业务查询的数据从事实/视图读取，不能因清理日志失去恢复能力。

## 3. 模型调用与 Provider

新增薄 Provider registry，将 provider 描述、能力与可执行 adapter 绑定，按插件 owner 清理。OpenAI-compatible 是默认注册项；ChatGPT 通过同一个注册契约提供适配器，不再靠 model interceptor 的专属短路来承担基础分发。

统一模型调用服务负责：Execution/request 身份、model pipeline、最终配置校验、Provider 分发、取消、attempt 追踪、幂等、结果/失败归档及恢复。主步骤与辅助操作共享实现，只有调用用途和提交目标不同：主步骤由 Runtime 原子提交 Assistant + Tool Calls；辅助结果以 namespaced fact/查询视图返回插件，不作为普通 Assistant 消息，也不执行其返回的 Tools。

保留插件 wrap/short-circuit/replace 尚未提交行为的能力；最终状态与结果仍由 Runtime 提交。移除全局 `executions.fail`，保留绑定当前 Invocation 的 fail。

Thread ModelSelection 的最小公开值：configured provider identity、model、经能力校验的 parameters。区分 adapter/protocol ID 与已配置连接 ID；第一版可用现有连接作为默认 identity，但契约不能把 endpoint/密钥写进 Thread。不要增加账户/配置管理产品 UI。

- 创建 Thread 时固定默认选择；旧 Thread 首次迁移固定当时默认，并追加迁移事实。
- Child 默认复制父 Thread 的有效选择；显式覆盖经目标 Provider 校验。换 Provider/Model 时不携带不兼容参数。
- 同一 spawn execution 重投递不得因父配置后来变化而重配 Child；选择纳入创建幂等身份。
- 当前 Thread 的 Composer 修改 Thread 选择；全局设置仅作为新 Thread 默认。普通 Thread 和辅助调用都接受显式选择，辅助默认继承所在 Thread。
- Pipeline 修改之后确定最终请求身份。实际 Adapter、model、参数、事实归属必须一致；不存在的/停用的 Provider 明确报 unavailable，绝不静默使用其它 Adapter。
- 每次实际调用保存非敏感的有效配置。网络重试同一逻辑 Execution 沿用冻结配置；用户主动 Retry 新建 Execution，可显式采用 Thread 当前配置，并记录 retryOf。
- 主调用与辅助调用都完整传递 requestParameters、modelTarget、取消和可观测性。重启后孤立辅助 running 事实归为 interrupted；同一幂等键结果重放，不重复执行。

## 4. Projection、Executor 与插件交付

提取公共的 Canonical -> source-aware prompt block/turn 转换。Runtime 与 Rolling Context 使用同一实现；Rolling 仅按完整 block 保留/替换/省略。reasoningReplay 透明传递，失败结果 modelGuidance、多模态、Child 消息来源和 Tool Call/Result 配对语义一致。

Executor plugin 的 import/activate 仅在 Executor。Runtime 工具发现消费静态描述、已验证缓存或 Executor listTools；离线未有定义可报告 unknown/stale，不能执行插件获取 schema。Runtime/Executor ToolContext 分离，Executor 不暴露 Thread。远端 ledger 保留，用于执行去重和真实状态核实。

Model Parameters、Auto Thread Title、Vision 迁成普通独立插件入口；Workspace/Commands 可保留基础能力。参数控件消费通用选择/能力契约；Runtime 不迁移某个插件的私有键、不发布专属 Usage 事件。历史兼容迁移集中处理，不能丢数据。

UI 尺寸偏好作为贡献元数据；Global 设置页与 Project toolbar 各自注册。清理旧 CONTAINER_RUNNER 和只验证死路径的测试，把仍有效的语义覆盖迁到实际 agent/协议路径。保留有用测试，不以删除失败断言代替修复。

## 5. 串行执行顺序

每阶段使用一个新的 Luna 实现代理；完成、退出后，再使用另一个新的 Luna 验证代理。代理不得派生子代理，不得并行实现/运行多组测试；每位代理仅使用一次。协调者负责契约、整合和最终验收。验证发现的问题由后续新的修复代理处理，再由新的验证代理复核。

| 阶段 | 实现范围 | 进入下一阶段的门槛 |
|---|---|---|
| S1 | Canonical 内部事实/作用域、状态视图和导入/重放；私有凭据；诊断隔离 | A1-A5 与类型检查通过；独立验证 |
| S2 | Provider registry、统一模型调用、Thread ModelSelection、辅助调用恢复 | A6-A10 与相关模型/Runtime 测试通过；独立验证 |
| S3 | Workflow 原子提交/纯 continuation、Child 配置继承和 UI 参数作用域 | A11-A14 与 Workflow/Collaboration/UI 测试通过；独立验证 |
| S4a | 共用 Projection、Executor 插件边界/上下文、遗留 runner 清理 | A15-A17 与相关执行器/投影测试通过；独立验证 |
| S4b | 动态插件交付、UI 元数据与剩余宿主专属分支清理 | A18-A19 与插件/UI/构建检查通过；独立验证 |
| S5 | 完整回归、构建、故障注入、隔离 Runtime 实测与最终审查 | A1-A20 整体验收；如有失败进入串行修复/再验证 |
| S6 | Runtime 核心 `/compact` fallback 与 Rolling Context 投影组合 | A21、compact / projection 定向测试、类型检查与 diff 检查通过；不依赖 Rolling Context 插件 |

## 6. 可执行验收标准

- A1：旧 Canonical 行逐行保持内容不变；旧状态现状快照导入幂等，重复启动不重复导入。
- A2：Thread/非 Thread 事实排序和幂等 ID 正确，内部事实不污染模型 turn、消息 UI 或 Rolling 分段。
- A3：清空工作流物化视图后，从 Canonical 重建 Execution、Pause、Plugin State、模型选择、辅助结果，业务值一致；不需要诊断日志，不产生工具/模型调用。
- A4：事实提交失败，状态视图与对外成功通知不前进；Goal/Memory 多步写入失败原子回滚。
- A5：诊断写入全部失败/诊断缺失时，成功模型仍提交、执行仍可恢复。凭据哨兵不会出现在 Canonical、公开 Snapshot 或诊断。
- A6：停用/缺失所选 Provider，明确失败并暂停；默认 Adapter 调用次数为零。
- A7：model pipeline 改路由/参数后，Adapter 接收值、请求身份、Canonical 归属一致。
- A8：主/辅助调用的 modelTarget、requestParameters、取消行为相同；辅助不提交普通 Assistant 或启动 Tool Batch。
- A9：同幂等键不重复调用；重启将孤立辅助 running 标为 interrupted；可显式建立新 attempt。
- A10：同一 Thread 只有一个主 loop；辅助操作不被误算为第二条主 loop，不阻塞合法 Reviewer；原 Pause/Interrupt/并行整批返回不变量保持。
- A11：父/Child 的模型和参数可不同，修改全局默认/父选择不影响已有 Child；spawn 重投递与重启保持同一 Child 和选择。
- A12：无效模型参数明确拒绝，换模型不继承不兼容选项；已有 UI 可改当前 Thread，Settings 默认不暗改其它 Thread。
- A13：连续 hasPendingWork 查询不写状态/审计、不暂停 Thread；Goal 步数按已提交事实最多消费一次，重启一致。
- A14：Global Memory 在 Settings，Project Memory 在 toolbar；无 Thread 的 Global 编辑也有足够的事实恢复内容。
- A15：启停 Rolling Context 且所有段 hot 时，工具失败 modelGuidance、Child 消息、reasoning replay、多模态、Tool Call/Result 配对不变；摘要只替换完整 block。
- A16：仅初始化 Runtime/Chat 时，Executor plugin 模块/activate 的哨兵副作用次数为零；实际 Executor 仍能发现并执行插件 Tools。
- A17：ExecutorToolContext 不含 Thread，RuntimeToolContext 明确提供 Thread；禁止任意 Execution fail 的插件接口已删除。
- A18：可选业务插件来自独立入口，可单独启停/重载；主 Runtime/Web bundle 不静态包含其业务实现。必要生成产物与构建脚本同步。
- A19：无 Rolling Context ID 宽度特判、无 Runtime 业务插件私有迁移/专属 Usage 事件、无死 runner 生产源码；有效测试改测真实路径。
- A20：类型检查、完整测试、构建及 diff 检查通过。隔离 Runtime 使用临时 DB/端口/workspace；允许本机端口的测试不得使用生产 DB。必要的真实 GPT-6 Luna 调用通过测试 Thread 验证，明确报告实际模型、Provider、结果与验证边界。
- A21：即使 Rolling Context 未安装或已停用，Runtime 仍注册 `/compact`；只总结完整 Canonical turn block，保留最近两轮原文并限制输入/摘要大小。成功摘要以版本化 Canonical fact 保存，原始记录不变；重启后从唯一事实重建同一 Projection。失败/超限不产生 compact fact，不创建第二条主 loop、普通 Assistant 或 Tool Batch；Rolling Context 启用时必须保留 Runtime 摘要前缀。

## 7. 操作边界

保留工作区原有未跟踪 demo/。不提交或修改无关文件，不改 .git，不启动/重启现有生产服务，不直接迁移生产 DB。测试和开发 Runtime 只用 /tmp 下隔离数据目录，限制模型调用数量。发现必须改变上述契约时，先交协调者决策，不能自行缩减验收或长期保留第二执行实现。

## 8. 实施与验证记录

本节由协调者在各阶段独立验收后更新，记录完成范围、检查结果和剩余限制。

- S1：已实现并经另一位全新 Luna 代理独立验收 A1-A5。内部事实使用 `workflow:*` scope，原 Thread seq 保持；提供状态视图重建和 legacy-import；OAuth 与缓存分别迁到私有/缓存存储；诊断 best-effort。实现侧 Runtime 38 项通过；独立侧 Store/ChatGPT/权限等 24 项及类型检查、迁移/故障/重建探针通过。需要本机端口的测试使用授权运行和唯一临时数据库。辅助 running 的重启恢复留 S2。
- S2：共享 invokeModel、Provider registry、ThreadModelSelection 事实/视图、主/辅助请求配置与取消、孤立辅助调用恢复已实现。首轮独立验证发现最终 connectionId 校验和幂等请求身份缺口，已由新的修复代理处理，再由另一位新的验证代理复验 A6-A10 通过：Provider 7、Store 13、Runtime 38、类型检查通过。独立 endpoint 改路由探针确认旧密钥不跨 endpoint。当前只配置 `connectionId=default`，契约保留独立连接身份，未知连接明确拒绝；本轮不新增多账户配置 UI。
- S3：语义参数、通用参数能力/一次性偏好导入、Thread scoped HTTP/Composer/iframe 更新、child 选择继承/覆盖/幂等、Workflow 原子写入、纯 continuation + 既有 step 消费已实现。实现者 11 文件/61 项通过；独立验收 A11-A14 通过，并发现两项旧 Runtime fixture 缺模型。已用新的测试代理修正并补跨 SQLite 重启/事实重建的 spawn 重投递集成，另一个新的验证代理确认 Runtime+集成 39/39、加协作插件 43/43、类型检查通过。集成直接调用 Runtime 注册的真实 spawn handler，覆盖 Child 幂等与选择持久化，完整 Invocation 包装由既有 Runtime 测试覆盖。生产可见 UI 尚未验证。
- S4a：共享 source-aware Canonical 转换、Runtime/Executor 插件激活隔离、静态 schema 单一来源、纯 ToolCatalog、上下文类型分离与旧 runner 清理已实现。独立验证 A15/A16：Rolling 7、Executor 插件 2、Tools/Context 10、Executor 16、Remote 11、离线面板 1 项及类型检查通过；无旧 runner 生产引用。A17 公共能力已收窄，但权限插件私有 PermissionContext 尚有未使用的 executions.fail 类型残留，已明确交 S4b 清除并复核。
- S4b：Model Parameters／Auto Thread Title／Vision 已迁到普通动态入口，builtin 仅余 Workspace／Commands；构建脚本串行生成入口及 UI 产物。旧 ChatGPT 偏好由独立兼容迁移处理，Usage composer 摘要由插件贡献，刷新走通用失效通知，尺寸和 Memory 分组由贡献元数据控制；A17 私有权限类型残留已清除。首轮独立验证发现 Usage 切换 Thread 的迟到响应覆盖，已由新的代理修复请求代次／Thread 检查并补乱序成功、失败、同 Thread 重刷与清空 Thread 用例，另一位新代理独立复验通过。独立验收包括产物隔离检查、插件停用后的参数处理、迁移幂等，以及最终 8 文件／30 项定向测试、类型和 diff 检查。最终验证者曾误启多 worker，随后已逐文件串行重跑全过；后续所有测试显式限制单 worker。A18-A19 通过，完整回归与隔离 Runtime 实测留 S5。
- S5a：首轮完整回归 254／255，通过构建和类型检查；唯一失败在测试夹具尚未触及迁移前，将新版非 Thread workflow 行复制进旧版 NOT NULL 表。新的代理只修正旧表样本范围，保留原断言并补旧行全字段不变和重开幂等比较；另一个新的代理独立确认夹具语义后，串行重跑 53 文件／255 项全部通过，类型检查、完整构建和 diff 检查通过。本机端口测试经授权运行，DB／Executor 数据均在唯一临时目录；日志位于 `/tmp/pico-s5a-final-o2hY4C/`。构建有客户端约 519 KB 超过默认 500 KB 提示和 Executor 约 1.1 MB 大小提示。隔离 Runtime 烟测与最终架构审查尚待 S5b。
- S5b 首轮：只读审查未发现额外主 loop；隔离 Runtime 经真实 loopback OpenAI-compatible HTTP 完成 Project／Thread 创建、`smoke-model`／temperature 0.37 请求和 Assistant 提交，未知 Provider 被拒且配置不变，停用 ChatGPT 后不调用默认 Adapter，删除诊断后重建恢复 Execution 与模型选择。A5 新增故障探针失败：上游 401 回显合成 Authorization 哨兵时，原始异常进入主 Execution／公开 Snapshot／runtime.error；辅助记录自身已脱敏，但原始重抛异常可经 Rolling Context 状态进入事实。尚未最终验收，必须统一模型错误传播边界并独立复验。探针未使用真实凭据、未调用外部模型／浏览器；隔离进程已关闭，非敏感摘要保留在 `/tmp/pico-s5b-evidence-20261021-8b57e4/summary.json`。
- S5b 修复：新的代理增加轻量安全模型错误契约，共享 invokeModel 覆盖整条 model pipeline，外部 message／cause／任意 name、code 不再透传；OpenAI-compatible HTTP 失败不读取正文，主／辅助持久化与插件异常只接收固定类别／状态摘要，本地配置错误保留可行动提示。Provider trace 错误码改用白名单，历史诊断读取同样过滤。故障探针另发现未取消 signal 的 Adapter AbortError 可造成反复新建模型尝试，已改为只有 Runtime signal 取消才按中断处理，上游自行 AbortError 失败并暂停，新增单次调用／drain 结束断言。实现者最后串行全量 54 文件／259 项、类型、构建及 diff 检查通过；等待另一位新代理独立复验后才可最终验收。
- S5b 最终独立验收：另一位新代理确认 A1-A20 在约定范围内全部通过。定向错误边界／Provider 13 项通过；最后串行完整 54 文件／259 项、类型检查、完整构建和 diff 检查通过。真实隔离 Runtime 的 loopback HTTP 401 回显合成凭据哨兵，主／辅助 Execution、公开 Snapshot／通知、诊断、完整 workflow Canonical 原始事实、plugin_model_calls、Plugin State 均未检出哨兵，事实重建前后结果一致；正常请求 `smoke-model`／temperature 0.37 成功提交 Assistant，Provider／Project／Thread 归属正确。未取消 signal 的上游 AbortError 单次调用后失败暂停，真实 Runtime Interrupt 路径保持 interrupted 且不提交 Assistant。自启 Runtime／上游／辅助探针均已关闭；没有外部 GPT-6 Luna 调用和可见浏览器验收，没有生产 DB 迁移／服务重启／部署／提交。构建体积提示仍在，当前连接实现仍限 default，多连接身份契约已预留。
- S6：Runtime 核心注册 `/compact`；该命令总结完整 turn block、保留最近两轮、把摘要与 source IDs/hash 追加到线程 Canonical，并在 Runtime 重启后复用摘要投影。Rolling Context 不再注册该命令，也不会重复总结已压缩前缀；其分层面板投影保留 Runtime 摘要前缀。Runtime compact 重启集成用例、Rolling Context 投影组合测试、Usage iframe 测试与类型检查通过；全量 `npm test -- --no-file-parallelism --maxWorkers=1` 为 54 文件／261 项通过，`npm run build` 与 `git diff --check` 通过。首轮沙箱内全量运行因 Host Executor 无法绑定 `127.0.0.1` 失败；按既有本地验证授权串行重跑后通过，未连接外部模型或生产数据库。
