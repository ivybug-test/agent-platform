# CHANGELOG.md

## 项目状态
Phase 2 完成(tool-calling agent + 记忆工具 + UI)。多用户记忆重构(原 `streamed-yawning-pancake` 计划的 Phase A–D)也全部落地:subject/author 拆分、待确认代写流程、房间共享记忆、双向确认的用户关系。动态记忆 Phase A 于 2026-04-19 落地。2026-04-25 落地多模态(眼睛)+ 联网搜索 + 链接预览卡片:Kimi K2.6 视觉路由、异步 caption 管线、web_search/search_lyrics/fetch_url 工具(Bocha 主 / Tavily 备)、QQ 音乐 / 网易云专用 OG 卡片 adapter。剩余项:Phase C 嘴巴(TTS + 唱歌)、动态记忆 Phase B(由反复出现的事件聚合成语义 fact)、向量语义去重(D2)、MCP 集成。

## 当前阶段
Phase 2 — Agent 架构升级(已完成);多用户重构(已完成)

## 已完成

### Milestone 0:规划(2026-04-05)
- 明确产品方向和分阶段路线
- 审阅 CLAUDE.md,标出模糊点和风险
- 确认所有架构决策:
  - 全栈 TypeScript
  - agent-runtime 作为独立 Fastify HTTP 服务
  - OpenAI Node.js SDK,自建 agent 编排
  - Phase 1 用 SSE 流式(Phase 3/4 再加 WebSocket)
  - Auth.js + credentials provider
  - Drizzle ORM
  - BullMQ 做任务队列
  - agent-runtime **不**连数据库;context 通过 HTTP body 传入
  - Next.js 在聊天结束后触发 memory-worker 任务
  - MCP 支持延到 Phase 2
- 精简 repo 结构:从 MVP 里去掉 packages/config、packages/prompts、packages/sdk
- 补齐数据模型细节:rooms.system_prompt、room_members.member_type、messages.status、系统消息允许 sender_id 为 null
- 定义了渐进式 milestone 路径(M0→M6)
- 识别并记录开发 / 测试 / 维护风险

## 决策
- 全栈 TypeScript(权衡过 Python Agents SDK,MVP 阶段选 TS 更简单)
- agent-runtime 用 Fastify(独立 HTTP 服务)
- OpenAI Node.js SDK(自建编排,顺便学 agent 模式)
- Phase 1 用 SSE 流式
- Auth.js(先 credentials provider)
- Drizzle ORM
- BullMQ 做异步任务队列
- 本地开发用 Docker Compose(PostgreSQL + Redis)
- agent-runtime 带 mock mode 方便 UI 开发
- 流式消息持久化:先写入 `status=streaming`,完成后更新为 `completed`

### Milestone 1:Monorepo 骨架(2026-04-05)
- 初始化 pnpm workspace(pnpm@9.15.4)+ Turborepo
- 搭好 root 配置:package.json、turbo.json、tsconfig.base.json、.gitignore、.env.example
- 搭 apps/web,最小 Next.js App Router
- 搭 packages/types 和 packages/db,先放占位导出
- 搭 services/agent-runtime,带 Fastify health 端点
- 搭 services/memory-worker,占位
- 建 infra/ 和 docs/ 目录
- 验证:`pnpm install` 和 `pnpm -r build` 都成功

### Milestone 2:最简聊天链路(2026-04-05)
- agent-runtime:POST /chat 端点,用 OpenAI SDK 做 SSE 流
- LLM client 用惰性初始化(getClient/getModel),配合 dotenv 能正常工作
- 支持通过 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 配置 provider
- Mock 模式(MOCK_LLM=true)返回假的流式响应,给 UI 开发用
- apps/web:/api/chat 路由转发到 agent-runtime,把 SSE 原样流回前端
- apps/web:聊天 UI,消息列表 + 输入框 + 流式显示
- 端到端验证:DeepSeek API 的流能经 Next.js → agent-runtime → 浏览器跑通
- D1 风险解除:Next.js 用 Response body passthrough 做 SSE 代理是可行的

### Milestone 3:数据库 + 消息持久化(2026-04-05)
- Docker Compose:PostgreSQL 16 + Redis 7(infra/docker-compose.yml)
- Drizzle schema:users、agents、rooms、room_members、messages、user_memories、room_summaries
- drizzle-kit push + generate migration
- Seed 脚本:demo 用户 + assistant agent + General 房间
- apps/web:/api/chat 现在会持久化用户消息、新建 streaming 状态的 agent 消息、完成后更新
- apps/web:/api/messages 返回房间历史,/api/rooms 返回房间列表
- apps/web:页面挂载时从 DB 加载历史
- Next.js env 通过 dotenv 加载(从 apps/web 读 root .env)
- Next.js 的 serverExternalPackages 配置了 postgres 驱动
- 验证:刷新后消息仍在

### Milestone 4:房间(2026-04-05)
- 把页面重构成 sidebar + chat panel 两栏布局
- 抽出 ChatPanel 和 Sidebar 组件
- POST /api/rooms 创建房间并自动绑定默认 agent
- GET /api/rooms 按创建时间返回所有房间
- 切换房间时按房间加载消息(ChatPanel 靠 key 重新挂载)
- 验证:两个房间,消息历史完全隔离

### Milestone 5:认证(2026-04-05)
- Auth.js(next-auth beta)+ credentials provider + JWT 策略
- 注册 API(/api/register)用 bcryptjs 做 password hash
- 登录页 + 注册页,表单校验
- layout 里放 SessionProvider,客户端可读 session
- Middleware 把未登录用户重定向到 /login
- 所有 API 路由通过 getRequiredUser() 做 session 校验
- 房间通过 room_members 关联用户(基于成员资格,不是 owner 独占)
- schema 加 rooms.createdBy 字段
- Sidebar 显示当前用户名 + 登出按钮
- apps/web/.env.local 给 Next.js 原生 env 读(AUTH_SECRET、DATABASE_URL)
- 修 rooms 查询:改成两步查(memberships → rooms)而非 innerJoin

### Milestone 6:房间摘要 + 用户记忆(2026-04-10)
- services/memory-worker:BullMQ `memory` 队列消费者,按 job name 分发
- apps/web:`lib/queue.ts` 的 `pushMemoryJobs(roomId, userId)` 在 `lib/chat/stream.ts` 流式结束后调用
- Job 1 — room-summary:
  - 每轮聊天都触发;除非自上次摘要以来新增消息 ≥20 条(`SUMMARY_THRESHOLD`)才真跑
  - 读最近 100 条消息,解析真实用户名,把上一版摘要 + transcript 喂给 LLM
  - 新行 append 进 `room_summaries`(append-only,读时取最新一行)
- Job 2 — user-memory:
  - 按用户去重:`jobId = user-memory-{userId}-{5min-bucket}`(同一用户 5 分钟最多一次抽取)
  - 用户在房间内消息数 <3 就跳过
  - 加载该用户的**全部**活跃记忆,按 category 分组带 id,喂给 LLM
  - LLM 用 `response_format: json_object` 返回严格 JSON `{actions: [create|update|delete]}`
  - Actions 在单个 DB 事务里应用;写入前校验 category / importance 枚举
  - Category:identity | preference | relationship | event | opinion | context
  - Importance:high | medium | low(影响读侧排序)
- Schema:
  - `user_memories`:content、category(enum)、importance(enum)、sourceRoomId、userId、时间戳
  - `room_summaries`:content、messageCount(string)、roomId、createdAt(append log)
- 读路径(apps/web `lib/chat/context.ts`):
  - `getLatestSummary(roomId)` —— 最新一条 summary
  - `getRoomUsersMemories(roomId)` —— 房间所有用户成员的记忆(每人最多 15 条),按 importance + recency 排序,按用户名 → category 分组
  - `buildSystemPrompt` 把 memory 段("What you remember about {name}:")和 summary 段注入六层 prompt
  - 按架构规则,context 组装留在 Next.js 侧;agent-runtime 只收到构造好的 messages 数组
- Context dedup:bigram 相似度过滤,把窗口里的近重复 agent 回复剔掉再喂给 LLM(对 CJK 安全)

### 图片消息(2026-04-12)
- 用户可以在房间里发图片;图片像文本消息一样广播到其他成员,但**不**触发 LLM
- 存储:腾讯云 COS(bucket `agentimage-1411620332`,region `ap-guangzhou`,公共读 / 私有写)
- 上传路径:浏览器 → COS 直传,Next.js 只负责签 STS 临时凭证
- 压缩:浏览器端 canvas,长边 ≤1600px,JPEG quality 0.8(`apps/web/src/lib/upload-image.ts`)
- 新路由 `POST /api/upload/sts` —— 校验房间成员身份,签发范围限定到单 key `rooms/{roomId}/{userId}/{yyyymm}/{uuid}.jpg` 的 STS,10 分钟 TTL
- 新路由 `POST /api/messages/image` —— 校验 URL 主机名(`*.myqcloud.com`),以 `contentType="image"`、`content=publicUrl` 持久化,发 `user-message` Redis 事件
- `RoomEvent.message` 增加可选 `contentType` 字段;ChatPanel 在 `contentType === "image"` 时渲染 `<img>`,否则回退文本
- ChatPanel:新增图片按钮用 `<input type="file">`,本地乐观 append + seenIds 对 Socket.IO echo 做去重
- Schema 无变化 —— M3 就已经有 `messages.contentType` varchar(50)
- 新依赖:`qcloud-cos-sts`(服务端 STS 签名)、`cos-js-sdk-v5`(浏览器端带临时凭证的 PUT)
- 环境变量:`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TENCENT_COS_BUCKET`、`TENCENT_COS_REGION`

## Phase 2 milestones

### A:记忆安全基础(2026-04-17)
- A1 — schema:`user_memories` 增加 `source`(enum `extracted | user_explicit`)、`deleted_at`、`last_reinforced_at`。Migration `0002_nifty_matthew_murdock.sql`
- A2 — `getUserMemories` / `getRoomUsersMemories` 加 `isNull(deletedAt)`,软删除不再出现在 prompt 里
- A3 — memory-worker 现在同时加载活跃记忆 + 墓碑,prompt 里用 "DO NOT RECREATE" 标墓碑。`source='user_explicit'` 做三层锁:抽取 prompt 标注、代码里 `lockedIds` 拦截、SQL `source='extracted'` 谓词。worker 的 DELETE 从硬删改成软删(变成墓碑),这样 agent/worker 不会陷入 create→delete 循环
- A4 — `/memories` 页面(列表 / 新增 / 编辑 / 遗忘)+ `GET/POST/PATCH/DELETE /api/memories[/:id]`。所有 UI 写操作都把 `source` 翻到 `user_explicit`,把行锁死不被自动流程覆盖

### B:Tool-calling 基础设施(2026-04-17)
- B1 — `services/agent-runtime/src/index.ts` 跑工具循环:按 `index` 流式累积 tool_call 的 `id/name/args`,遇到 `finish_reason=tool_calls` 停下,带 `Authorization: Bearer <jwt>` POST 到 `toolCallbackUrl`,把 `role:"tool"` 结果回喂,最多 `maxToolRounds` 轮(默认 5,硬上限 10)。SSE 协议扩展出 `{tool_call}` + `{tool_result}` 事件,和原有 `{content}` 并列。Mock 模式加了 `mockToolStream`,无真实 key 也能验证循环
- B2 — `apps/web/src/lib/tool-token.ts` 用 `jose` 签 HS256 JWT(`sub=userId`、`roomId`、10 分钟 TTL)。`apps/web/src/app/api/agent/tool/route.ts` 验签后分发到 `toolRegistry`。副作用的所有权由 token 决定,**不**信任请求 args
- 顺手修 — `packages/logger` 之前在模块加载时读 `LOG_DIR`,早于 dotenv。改成 `getLogger()` 内读取,非 root 部署就能覆盖默认的 `/root/agent-platform/logs`

### C:按需检索(2026-04-17)
- C1 — `apps/web/src/lib/tools/memory-tools.ts` 注册 5 个工具:
  - `search_memories({query?, category?, limit})` —— ILIKE 子串,软删除排除
  - `search_messages({query, limit, before?})` —— caller 房间内的 completed 消息;ILIKE 带 `\ % _` 转义;resolve 发送人名字
  - `remember({content, category, importance})` —— 写 `source='extracted'` 让 worker 仍能修正;bigram-Jaccard 近似重复保护(阈值 0.55)短路返回相似记忆而不新建
  - `update_memory({memoryId, content?, category?, importance?})` —— 盖上 `source='user_explicit'` + `lastReinforcedAt=now`
  - `forget_memory({memoryId, reason?})` —— 软删 + `source='user_explicit'`
- C2 — `buildSystemPrompt` 只 pin `category='identity' OR importance='high'` 的记忆(每用户 8 条上限)加最新 summary。新增 TOOL USAGE 段,讲清楚每个工具的用法,并叮嘱 agent 在当前 context 已足够时别调工具。`streamAgentResponse` 每次请求签一个 JWT,把 `tools: agentToolDefs`、`toolCallbackUrl`、`toolAuth` 一起传给 agent-runtime。生成房间标题的路径仍然不带工具
- 真实 DeepSeek 端到端验证过:用户 "请忘掉…我喜欢志龙哥" → agent 发出 `search_memories({"query":"志龙哥"})` → `forget_memory({memoryId, reason})` → 中文确认。DB 层:那行翻到 `deleted_at IS NOT NULL`、`source='user_explicit'`

## 多用户记忆重构(2026-04-18)

把记忆模型从"永远 1:1"改成"多用户 + 单 agent"。之前 `user_memories.user_id` 身兼"owner"和"subject"两职,群聊里 agent 想记"A 说的关于 B 的事"最后都变成了 A 自己的记忆。四个增量阶段,零破坏性迁移。

### Phase 1 — 严格 prompt 护栏
- `buildSystemPrompt` 追加 STRICT 段,禁止对说话者以外的人调 remember/update/forget,也禁止对其他成员做 search。零 schema 改动,可以立刻部署
- `docs/memory-system.md` §12 记录作用域矩阵(pinned vs tool 的非对称)和这条规则

### Phase 2 — subject/author 拆分 + 待确认代写
- Schema `0004_memory_authorship.sql`:`user_memories` 新增 `authored_by_user_id`(NULL 或 = user_id 代表自述;否则第三方)和 `confirmed_at`(第三方代写时 NULL = pending)。部分索引 `user_memories_pending_idx` 服务于"待确认"列表
- `apps/web/src/lib/memory-filters.ts` 暴露 `visibleToSubject()` —— 统一的 WHERE 表达式,pinned 注入、`search_memories`、`GET /api/memories`、`PATCH /api/memories/:id`、`update_memory` / `forget_memory` 都复用。保证 pending 行在 subject 接受前不会出现在任何地方
- `apps/web/src/lib/tools/resolvers.ts` · `resolveRoomMemberByName` —— 按房间成员列表做大小写不敏感的精确匹配。`remember(subjectName)` 和后续的 `relate` 复用
- 工具层:`remember` 新增可选 `subjectName`,第三方写入落 pending。`update_memory` / `forget_memory` 用 `visibleToSubject()`,pending 行不会被悄悄改。新增 `confirm_memory` 工具,agent 可以在对话里帮 subject 代收 pending fact
- API:`GET /api/memories` 返回 `{ mine, pending }`,带作者显示名。新增 `POST /api/memories/:id/confirm`。DELETE 处理 pending 行的"拒绝"
- UI:`/memories` 页面加 tab bar("我的记忆" / "待确认"),待确认 tab 带红点 + 接受/拒绝按钮
- Worker:抽取 prompt 对 `[PENDING]` 行的处理跟 `[LOCKED]` 一样(内容重复则 SKIP,禁止 UPDATE/DELETE);`pendingIds` 和 `lockedIds` 一起构成事务层面的第二道拒绝集
- Prompt:Phase 1 的强硬规则放宽 —— 对他人明显有跨会话价值的 fact,带 subjectName 调 remember 是对的,只是不鼓励为"顺口一提"的细节这么做

### Phase 3 — 房间共享记忆
- Schema `0005_room_memories.sql`:新表 `room_memories(id, room_id, content, importance, created_by_user_id, source, deleted_at, ...)`,带 `room_memories_active_idx` 部分索引
- 工具:`search_room_memory`、`save_room_fact`、`forget_room_fact` —— 都按 JWT 的房间范围锁;`forget_room_fact` 只动 `source='extracted'` 的行,UI 加的 `user_explicit` 行不会被工具路径删掉
- 注入:`getRoomMemories(roomId)` + `buildSystemPrompt` 的 `roomMemories` 字段,在房间规则和每用户 pinned fact 之间渲染新的 "Room context: ..." 层
- API:`GET/POST /api/rooms/:id/memories` + `PATCH/DELETE /api/rooms/:id/memories/:memId`,全部过房间成员校验。UI 写入 → `source='user_explicit'`
- UI:新 `RoomSettings.tsx` modal,从 Sidebar 房间 ⋯ 菜单的"房间共享事实"进入。支持新增 / 行内编辑 / 删除

### Phase 4 — 双向确认的用户关系
- Schema `0006_user_relationships.sql`:`user_relationships(a_user_id, b_user_id, kind, content, confirmed_by_a, confirmed_by_b, ...)`。CHECK `a_user_id < b_user_id` 规范化 pair 顺序;UNIQUE `(a_user_id, b_user_id, kind)` 防重复。两侧各有部分索引
- 工具:`relate({ otherUserName, kind, content? })` —— upsert,只填说话方那一侧的 `confirmed_by_*`;`search_relationships({ withUserName? })` —— 返回已双向确认、涉及说话者的边;`unrelate({ relationshipId })` —— 任一侧可软删
- 注入:`getConfirmedRelationshipsForUser(userId, roomMemberIds)` 返回**两侧都已确认**且另一方也在当前房间的边。`buildSystemPrompt` 渲染 "Known relationships involving {speaker}:" 层
- API:`GET /api/relationships` → `{ confirmed, pending, outgoing }`;`POST /api/relationships`(propose/confirm upsert);`POST /api/relationships/:id/confirm`;`DELETE /api/relationships/:id`
- UI:`/memories` 页面加"关系"tab,三段(待确认收件、已确认、已发出),以及一个行内"+ 新增关系"表单,候选人走 `/api/friends`
- 文档(`docs/memory-system.md`):§2 数据模型扩到 3 张表;§12 重写,描述现在的作用域矩阵 + 隐私默认值(自述公开到房间、他述私有到 subject、房间记忆公开、关系双向同意才生效)

## 动态记忆,Phase A(2026-04-19)

给记忆加一个时间维度,让它可以演化。设计源自 Park et al. 的 Generative Agents(recency × importance × relevance)和 MemoryBank(Ebbinghaus 遗忘曲线)。

- Schema `0007_memory_temporal.sql`:`user_memories` 增加 `event_at timestamptz` 和 `strength real NOT NULL DEFAULT 1.0`。部分索引 `user_memories_event_at_idx (user_id, event_at DESC) WHERE deleted_at IS NULL AND event_at IS NOT NULL` 服务时间范围检索
- Agent prompt(`buildSystemPrompt`):新增 Layer 1b,注入 `Current time: YYYY-MM-DD HH:mm Weekday (Asia/Shanghai)`,让 LLM 在写记忆前把"今天"/"昨天"/"刚才"解析到一个具体锚点
- 抽取 worker(`services/memory-worker/src/jobs/user-memory.ts`):
  - 喂给 LLM 的消息现在每行都有 `[YYYY-MM-DD HH:mm]` 前缀 + 一个"Current time"banner。Prompt 禁止存相对时间短语,要求对时间敏感的 CREATE action 带 `eventAt`
  - 瞬时状态("我现在饿了")必须 SKIP —— 重复出现的行为靠 reinforcement 自然涌现,不要在数据里塞种子
  - **近似重复 ≥0.55 Jaccard → REINFORCE,不是 skip**。现有行 `strength += 1`、`last_reinforced_at = now()`。locked / pending 行仍走旧的 skip 路径。这是动态记忆的核心信号:反复提及的变强,从没人提的在读侧自然衰减
- `remember` 工具(`memory-tools.ts`):接受可选 `eventAt` ISO 字符串;命中近似重复时强化已有记忆而不是返回 `skipped`。locked / pending 行仍然短路到 skip
- `search_memories` 工具:新增可选 `from` / `to` ISO 参数。带时间过滤时,结果集限定在 `event_at` 非空的行,并按 `event_at DESC` 时间倒序排列。返回行里包含 `event_at`,agent 能读回用
- `search_messages` 工具:补对称的 `after` 参数(与已有 `before` 对应);带 `after` 时用时间正序排列
- 读路径排序(`context.ts`):`MEMORY_SCORE_SQL = strength × importance_weight × exp(-age_days / 30)`,age 以 `COALESCE(last_reinforced_at, updated_at)` 为基准。`getUserMemories` 和 `getRoomUsersMemories` pinned 注入都用这个排序。30 天半衰期是可调的 MVP 值
- `infra/update.sh`:把 0007 加入幂等原生 SQL 迁移列表
- 文档:`docs/memory-system.md` 更新 —— §2 数据模型加 3 列,§4 写入章节标注强化行为,新增 §15 动态记忆章节,覆盖评分公式和时间范围工具用法

注意:`memory-worker` 日志 key 从 `dupSkipped` 改成 `reinforced`。Grafana / 日志消费者之前过滤旧 key 的要改

## Phase A 后续补丁(2026-04-19)

Phase A 上线当天,真实使用暴露的几个缺口立刻补上。

### 最近消息窗口的时间感知
- `buildLLMMessages`:每条 user 消息现在都有 `[YYYY-MM-DD HH:mm]`(Asia/Shanghai)前缀,agent 能看到整个 50 条窗口的时间流,不是只有 system prompt 里一个"Current time"锚点。成本:每行约多 18 token,在 8k 上下文里可忽略
- 若最近一条消息距离现在 >6 小时,在 system prompt 末尾附一行 gap note("about 3 days have passed since the last message in this room"),agent 能自然地开场"好久不见",不再像刚聊过一样回复
- 关键修复:assistant 消息**不**加时间戳前缀。早期版本两边都加,结果 LLM 模仿格式,每次回复都以 `[2026-04-19 13:56] ...` 开头。system prompt 规则 #2 也明确告诉模型方括号时间戳是 metadata,只读不复述

### 检索强化 recency(Park et al. 的另一半)
- `search_memories`:select 完后对返回行 id 列表异步 fire-and-forget `UPDATE user_memories SET last_reinforced_at = now()`。`strength` 故意不碰 —— 那个字段计"fact 被声明过几次",检索是另一种信号,只影响衰减锚点
- 补上真实缺口:被 agent 频繁**使用**的 fact(比如"住在深圳"在每次推荐餐厅时被查)以前会因为用户没再重复而衰减出 pinned。现在只要还被调用就保持新鲜
- 对 `source='extracted'` 和 `user_explicit` 一视同仁 —— 不改 content/category/deletion,user-locked 记忆也只是保持排名靠前,安全

### 聊天 UI
- ChatPanel:每条消息在 sender 名旁多了 `HH:mm`;跨天时插入居中的日期分隔胶囊(`今天` / `昨天` / `MM月DD日 周X`,超过一年加年份前缀)。Asia/Shanghai 格式
- Sidebar:房间按最近活跃时间排序。`GET /api/rooms` 通过相关子查询 `MAX(messages.created_at WHERE status='completed')` 返回 `lastActivityAt`,空房间 fallback 到 `rooms.created_at`。新的 `UserEvent: room-activity {roomId, at}` 由用户消息保存路径和 agent 消息完成路径(`publishRoomActivity` helper)广播给所有房间成员;客户端更新对应行并重新排序
- FLIP 动画:`rooms` 重排时,`useLayoutEffect` 拍下每行 `offsetTop`,layout 后再次测量,对位置变化的行应用反向 `translateY`,下一帧用 260ms cubic-bezier transition 回零。没用动画库,纯 DOM

### 跨浏览器兼容:旧款华为 / HarmonyOS / Quark 的"白侧栏"
根因:DaisyUI v5 所有主题色都用 `oklch()` 声明。Chromium <111 的浏览器把整条 `--color-base-*` 声明当作非法丢弃,变量变 unset,`bg-base-200` / `bg-base-300` 绘成白色。三步修复:
- `globals.css`:`@supports not (color: oklch(0% 0 0)) { [data-theme="dark"], :root { --color-base-100: #1d232a; ... } }` —— 只在不支持 oklch 的浏览器触发,现代浏览器保持 DaisyUI 原生 oklch 不变
- `layout.tsx`:把 `data-theme="dark"` 提到 `<html>`,让属性选择器从根解析,所有子节点都能继承。子组件里的散落副本保留当双保险
- Next `Viewport` 里加 `colorScheme: "dark"` + `themeColor: "#111111"`,移动端滚动条 / 表单控件 / 地址栏也走暗色

### 存量数据清理 CLI
- `services/memory-worker` · `pnpm backfill-event-at [--dry-run]` —— 把 `source='extracted'` 的历史记忆过 LLM 再跑一次,用 content 推导 `event_at`。相对时间短语(`今天` / `昨天` / `刚才`)以该行自己的 `created_at`(≈ 用户消息时间)作锚点。SQL 谓词双重锁 source,user_explicit 行绝对不动。幂等
- `services/memory-worker` · `pnpm strip-numbered-prefix [--dry-run]` —— 纯正则清理早期 extractor 意外把 `^\s*\d+\.\s+` 编号前缀存进 content 的脏数据。不调 LLM

### update.sh 健壮性
- 把 bash 专有的 `source` 换成 POSIX 的 `.`,dash 也能跑
- 自我修改脚本的护栏:先 git pull,再 `exec "$0" "$@"` 让后续逻辑跑在新拉下来的文件上(避免 `git pull` 在运行中重写 `update.sh` 导致的 line-offset 错乱)

## 多模态 + 联网搜索 + 链接卡片(2026-04-25)

给 agent 装上"眼睛、嘴(规划)、搜索"三件套的 A + B 阶段。Phase C(TTS 嘴巴)留下一轮做。本次范围:让 agent 能看图、能联网、回复里出现 URL 时前端渲染成卡片。

### 眼睛 — Kimi K2.6 视觉路由
- DeepSeek 不支持多模态。决策:**图片在最近 50 条窗口里时,整段 LLM 调用切到 Kimi K2.6**(256K 上下文 + vision + tools + 比 moonshot-v1-vision-preview 强)。一旦图被挤出窗口,自动回落 DeepSeek
- 拒绝了"caption-then-chat"路线:会丢像素细节、要两次 LLM 往返、引用追问("那第二张呢")会失败。Kimi vision token 单价跟 DeepSeek 同档,整段切过去更省事
- 路由判断在 Next.js(`apps/web/src/app/api/chat/route.ts`):扫描 `recentMessages` 的 `contentType==="image"`,把 `provider: "kimi" | "deepseek"` 加进发给 runtime 的 body。CLAUDE.md 强制 agent-runtime 保持 provider-agnostic
- `buildLLMMessages`(`apps/web/src/lib/chat/context.ts`):`ContextMessage` 加 `contentType?` 字段;遇到 image user 消息时输出 OpenAI vision content 数组 `[{type:"text",text:"[ts] Alice: [sent an image]"}, {type:"image_url",image_url:{url}}]`。COS 公网 URL 直接给 Kimi 拉
- agent-runtime(`services/agent-runtime/src/index.ts`):`/chat` body 加 `provider?: "deepseek"|"kimi"`,默认 deepseek。`mockVisionStream` 让本地 mock 模式肉眼能区分 vision 路径
- Kimi K2.6 限定 `temperature=1`、不接 `frequency_penalty/presence_penalty`,在 provider abstraction 里隔离

### 长期记忆补丁 — 出窗口图片仍可被引用
图被挤出 50 条窗口后两个 provider 都看不到。补一条**异步 caption 管线**让出窗口的图通过现有 memory 链路保留。
- Schema `0008_message_metadata.sql`:`messages` 加 `metadata jsonb` nullable 列。`packages/db/src/schema.ts` 同步 `MessageMetadata` 类型
- `services/memory-worker/src/jobs/caption-image.ts`:新 job handler。拉 image URL → 调 Kimi vision(memory-worker `llm.ts` 加 `llmCaptionImage(url)`)→ 写回 `messages.metadata.vision = {caption, model, generatedAt}`。幂等(已 caption 直接 skip)
- `apps/web/src/app/api/messages/image/route.ts`:写完 image 消息后 `pushCaptionJob(messageId)` 入队,不阻塞响应。`apps/web/src/lib/queue.ts` 新增 `pushCaptionJob`,带 `attempts: 3`、`backoff: exponential 5s`、`jobId` 去重
- `services/memory-worker/src/jobs/{room-summary,user-memory}.ts`:遇到 `contentType==="image"` 用 `m.metadata.vision.caption` 替换 message body(无 caption 时降级为 `[image: (caption pending)]`)。现有 summary 和 memory 抽取逻辑自动复用,普通图进 room_summary,揭示用户长期事实的图(如"这是我家狗 Max")自动抽成 user_memory
- 隐私限制:`user_memories` 跨房间共享,敏感图(身份证等)抽出来会到处可见。Phase A 不处理,作为 follow-up

### DeepSeek v4 升级 + flash/pro 模式切换
- 老 model 名 `deepseek-chat` / `deepseek-reasoner` 在 2026-07-24 弃用。env 默认改成 `LLM_MODEL=deepseek-v4-flash`(快速非思考)和 `LLM_MODEL_PRO=deepseek-v4-pro`(深度思考)
- agent-runtime `ChatBody.model: "flash"|"pro"`,每次请求决定走哪个;mock 模式 / `/summarize` 默认 flash
- 前端切换:`ChatPanel.tsx` 输入栏左侧加快速/深度按钮,每个房间独立 localStorage 持久化(key `chat-model-${roomId}`)。`/api/chat` body 接受 `model`,异常值收敛到 flash
- 踩到的坑:`tsx watch` 不监听 `.env` 改动,改完要 `touch` 一个 ts 文件强制重启子进程,否则 dotenv 还用旧值。pm2 / pnpm dev 重启就没事

### Provider abstraction 重构
之前 runtime 三个调用点(`/summarize` / 非工具 `/chat` / 工具 `/chat`)各自带 `provider === "kimi" ? ... : ...` 三元处理采样参数,加 K2.6 后变得很丑。
- `services/agent-runtime/src/llm.ts`:抽出 `PROVIDERS: Record<Provider, ProviderSpec>` 表,每个 provider 自描述 `buildClient()` / `resolveModel(mode)` / `sampling({withPenalties})`。一处声明、三处复用
- 对外暴露 `chatConfig(provider, mode, opts) → {client, model, sampling}`,index.ts 一行解决,没有任何 provider-specific 三元
- 加新 provider(以后接火山 / 通义)只要在 PROVIDERS 表里加一行,类型系统强制实现完三个方法

### web_search + search_lyrics 工具(Bocha 主 / Tavily 备)
- 选型基于 4 query × 2 provider 实测对比:Bocha 延迟 ~165ms vs Tavily ~1440ms(国内服务器境外网络)、`site:` 算子 Bocha 工作 Tavily 不工作、Bocha 中文时效查询返回结构化数据 vs Tavily 给通用门户落地页;Tavily 在英文权威源(openai.com 直接命中)反而占优 → 适合做 fallback
- `apps/web/src/lib/tools/web-search-tools.ts`:provider 抽象 + Bocha/Tavily 实现 + normalizer(去 HTML、collapse 空白、cap 300 字、URL dedupe)
- Fallback 触发**只在 primary 错误时**,空结果不触发(零结果有时就是真相,多搜一次容易给用户误导)
- Cache key 改成 provider-agnostic(`query:max`),一次成功后 5 分钟内任何 provider 配置都能复用,响应里 `provider` 字段说明实际 provenance
- Redis 限流 10/分钟、200/天 per user(限流 key 复用 `getRedisClient()`,跟 `searchMessages` 的限流模式一致)
- env 重新组织:`WEB_SEARCH_PRIMARY` / `WEB_SEARCH_FALLBACK` 选 provider,`BOCHA_API_KEY` / `TAVILY_API_KEY` 各自一个 key。改主备只改 env 不改代码
- `search_lyrics(song, artist?)`:内部用 `web_search` + `${song} ${artist} 歌词 site:y.qq.com OR site:music.163.com` 模板,作为唱歌功能(Phase C)的前置桥
- 系统提示 `toolGuidance`(`apps/web/src/lib/chat/context.ts`)给两个工具都点了名 —— 现有 prompt 把每个 memory tool 都点了名,新工具不点等于不存在

### fetch_url 工具(读网页全文)
当用户在聊天里粘 URL 时让 agent 主动调用读全文(8000 字截断),搜索结果 URL 不读。
- `apps/web/src/lib/tools/web-search-tools.ts` 内新增 `fetch_url({url})`,走 Tavily `/extract` 端点(已有 boilerplate stripping,~$0.005/URL)
- SSRF 防护:拒绝 localhost / `127.*` / `10.*` / `192.168.*` / `169.254.*` / `::1` 和 file:/data: 等 scheme
- 5/分钟、100/天 per user 限流;5 分钟内存 cache;single URL per call
- prompt 强约束:**只在用户主动丢 URL 时调用**。搜索结果 URL 用 snippet 就够,别为它再花一次 extract
- 已知限制:Tavily extract 不跑 JS,QQ 音乐 / 网易云这种 SPA 拿到的是空壳;静态页(知乎、新闻、博客、GitHub README、文档站、维基)都能完整读到

### 链接预览卡片
agent 回复 / 用户输入里出现 URL,在消息气泡下面渲染卡片(封面 + 标题 + 描述 + 站点名)。
- 后端 `apps/web/src/app/api/link-preview/route.ts`:GET `?url=...`,session 校验,返回 `{url, host, title?, description?, image?, favicon?, siteName?, ok}`
- `apps/web/src/lib/link-preview/og-parse.ts`:正则解析 OG / Twitter / `<title>` / `<meta name=description>` / `<link rel=icon>`,相对 URL 用页面 base 解析。生产页面 OG 标签格式都很稳,没引入 cheerio
- `apps/web/src/lib/link-preview/qq-music.ts`:`y.qq.com` 专用。从 URL 抓 `songmid` → 调 QQ 音乐公开 API(`c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=...`,header 带 `Referer: https://y.qq.com/`)→ 拼出"歌名 - 歌手"+ 专辑封面(`https://y.qq.com/music/photo_new/T002R300x300M000<albumMid>.jpg`)+ 专辑名 + 站点 logo。SPA 外壳里没 OG 时这条路救命
- `apps/web/src/lib/link-preview/netease.ts`:`music.163.com` 同款。`/api/song/detail/?ids=[id]`,header 带 `Referer: https://music.163.com/`
- `apps/web/src/lib/link-preview/index.ts`:adapter 优先 → OG fallback → host-only fallback。Redis 缓存 1h(成功)/ 60s(负缓存),fetch 6s 超时 + 512KB 字节 cap(OG meta 永远在 head)。fetch 完整失败时仍返回 `<host>/favicon.ico` 推测路径,前端 `<img onError>` 兜底
- `apps/web/src/components/LinkPreviewCard.tsx`:DaisyUI 紧凑横排(封面 64×64 / 标题 1-2 行 / 描述 2 行 / 站点名 1 行)。模块级 `Map<url, Promise>` 缓存避免同 URL 多次拉。骨架 loading 占位
- `ChatPanel.tsx`:`extractUrls(text)` 正则提 URL(去尾部 CJK + ASCII 标点,去重,单条最多 3 个),气泡正文下渲染卡片
- 实测:腾讯新闻完整 OG,QQ 音乐"晴天 - 周杰伦 / 专辑:叶惠美 / 真实封面图",example.com 标题 + favicon。GitHub 等境外站国内服务器可能 timeout,降级到 host-only 卡片

### 已知坑(部署时注意)
- `tsx watch` 不监听 `.env`;dev 改 env 要 touch 一个 ts 文件,prod 用 pm2 直接 `pm2 restart`
- Kimi K2.6 不接 `frequency_penalty/presence_penalty`,只能 `temperature=1`。已经在 PROVIDERS 表里隔离
- COS 必须配,否则图片上传 0 字节 → 眼睛和 caption 管线断链
- `AUTH_SECRET` / `INTERNAL_JWT_SECRET` 必须 prod 重新生成,不能照搬 dev
- agent-runtime 和 web 之间 `AGENT_RUNTIME_URL` / `WEB_BASE_URL` 必须互通(工具回调走 web 这条,跨机部署要走内网 IP)
- memory-worker 必须开,不然 caption 任务积在队列里,room_summary / user_memory 也不更新
- prod 跑 `pnpm --filter @agent-platform/db db:migrate` 应用 0008 迁移

## Pro 思考截断兜底 + flash 不再露思考 + 输入栏瘦身(2026-04-25)

测试反馈:pro 模式思考链太长时回答被截掉,agent 只想不答;flash 模式偶尔也透出思考面板,体验割裂;移动端输入栏被「快速/深度」按钮挤窄。一并修。

- `services/agent-runtime/src/index.ts`:fast path 和 tool-calling path 都加上 `max_tokens=4096`(只约束最终回答,不动 DeepSeek 独立的思考预算)。流结束后判定:**有 reasoning 但 content 为空、且没有 tool_calls** → 用 flash 模式重跑同一组 messages,把回答续上 SSE 流。等于 pro 跑挂时静默降级到 flash,而不是把空气泡丢给用户
- 同一处加 mode-aware 过滤:`mode === "flash"` 时服务端直接不转发 `reasoning_content` 事件。前端 `stream.ts` 累加器拿不到,自然不会写进 `metadata.reasoning`,以后重新加载也不会显示思考面板。比前端隐藏更彻底,而且历史 pro 消息不受影响
- `services/agent-runtime/src/llm.ts`:DeepSeek 和 Kimi 两个 OpenAI client 都加 `timeout: 60s` + `maxRetries: 1`。SDK 默认 10 分钟超时,上游卡住(比如 Kimi 拉不到图片 URL)用户会一直转圈;1 分钟既给正常流式留够时间,又能在真挂的时候快速报错。streaming 请求一旦下了 header 就不再重试,maxRetries 只对开始前的 5xx 生效
- `apps/web/src/components/ChatPanel.tsx`:输入栏「快速/深度」按钮在移动端(`< md`)折成 ⚡/🧠 emoji,只在桌面保留文字。原 `min-w-[3.5rem]` 改成 `md:min-w-[3.5rem]`,挤压输入框的根因解除

## 尚未开始
- Phase C 嘴巴 — TTS 语音回复(MiniMax Speech-02 主 / Tencent Cloud TTS 备)、可中断的浏览器流式播放(MSE + AbortController)、agents 表加 voiceProvider/voiceId/voiceName、唱歌的最小可行版(`sing_song` 工具调 `search_lyrics` + 朗读副歌片段 + QQ 音乐跳转按钮)
- 多模态 follow-up — caption 进 user_memories 时的隐私过滤(身份证 / 信用卡 / 私人照片),避免跨房间泄露
- Phase 2 D1 — `messages.content` 的 pg_trgm GIN 索引,让 `search_messages` 在超过几千行后还能快
- Phase 2 D2 — 系统化的记忆去重(pgvector + cosine,或定期 cron 合并)。C1 的 `remember` 现在只有 bigram 快查
- 动态记忆 Phase B — 周期性聚合:对同一用户、相似 content、分散 event_at 的 `category='event'` 记忆聚类 → LLM 提炼成更高阶语义 fact("经常不吃午饭"),原 event 保留作证据,陈旧的自然 decay 出去
- Phase 2 MCP 支持 —— 通过 Model Context Protocol 接第三方工具
- Phase 2 prompt versioning(抽到 `packages/prompts`)

## 风险 / 备注
- D1 历史遗留:Next.js SSE proxy —— 已在 M2 解决
- D3 历史遗留:mock 模式 UI 开发 —— 已完成
- Phase 2 风险 —— mock 模式只会合成一个 tool_call 路径(永远是 defs 列表第一个工具)。真实 LLM 的 tool choice / 多轮 / 参数形状差异,必须用真 key 跑过才算;别用 mock 覆盖度去验证 C1/C2
- Phase 2 风险 —— `remember` 的相似度阈值(0.55 bigram Jaccard)能拦明显的改写,拦不住同义改写,语义去重等 D2
- Phase 2 风险 —— memory-worker 仍然同步调 OpenAI,没有 mock 路径。`LLM_API_KEY` 空时后台任务会明确报错

## 下一步
Phase A 现在已特性完整,包括读侧强化。**D2(基于 pgvector + embedding 的语义去重)是下一个主阵地** —— 不做的话,Phase A 的 reinforce 信号会被"喜欢甜食" vs "爱吃蛋糕"这类近义改写打散到多行而不是集中到一行。D2 同时是 Phase B 的前置条件:consolidation 需要干净的基础来聚类事件。Phase B 本身(反复事件 → 语义 fact)仍然要等 Phase A 跑 ≥2 周、有真实强化数据再校准聚类阈值。之后再评估 MCP 和授权模型(比如 subject 屏蔽特定作者)

## 更新规则
每次有意义的实现步骤后,追加:
- 完成了什么
- 做了哪些设计决策
- 哪些走不通的方案值得留记录
- 建议下一步做什么
