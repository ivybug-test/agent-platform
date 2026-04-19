# TASKS.md

## Phase 1 — 文本 MVP

开发按渐进路径推进,每个 milestone 都可以独立验证。

---

### Milestone 0:规划文档 ✅
- [x] 明确产品方向和架构
- [x] 确认所有技术决策(Fastify、OpenAI Node SDK、Drizzle、BullMQ、Auth.js)
- [x] 更新 CLAUDE.md,写入已确认的决策
- [x] 更新 TASKS.md 的 milestones
- [x] 更新 CHANGELOG.md

### Milestone 1:Monorepo 骨架 ✅
依赖:无

- [x] 初始化 pnpm workspace
- [x] 加 Turborepo 配置
- [x] root package.json 带 dev/build/lint 脚本
- [x] 建 `.gitignore`
- [x] 建 `.env.example`
- [x] 搭各目录,带 package.json + tsconfig.json:
  - [x] apps/web(Next.js)
  - [x] packages/types
  - [x] packages/db
  - [x] services/agent-runtime(Fastify)
  - [x] services/memory-worker
  - [x] infra
  - [x] docs

**已验证**:`pnpm install` 成功,`pnpm -r build` 无报错

### Milestone 2:最简聊天链路(无 DB、无 auth) ✅
依赖:Milestone 1

- [x] agent-runtime:Fastify 服务 + POST /chat 端点
  - [x] request body 收 messages 数组
  - [x] 调 OpenAI API 流式
  - [x] 返回 SSE 流
  - [x] 支持 mock 模式(env:MOCK_LLM=true)
- [x] apps/web:简单聊天页
  - [x] 消息列表组件
  - [x] 消息输入组件
  - [x] 发送时调 Next.js API 路由
  - [x] 展示流式响应
- [x] apps/web:API 路由转发 agent-runtime 的 SSE
- [x] 硬编码用户,无持久化(刷新就没了)

**已验证**:两个服务都跑起来,浏览器能看到 DeepSeek 流式回复

### Milestone 3:数据库 + 消息持久化 ✅
依赖:Milestone 2

- [x] infra:Docker Compose 带 PostgreSQL + Redis
- [x] packages/db:Drizzle schema
  - [x] users 表
  - [x] agents 表
  - [x] rooms 表(带 system_prompt)
  - [x] room_members 表(带 member_type)
  - [x] messages 表(带 status)
  - [x] user_memories 表
  - [x] room_summaries 表
- [x] packages/db:Migration 配置(drizzle-kit)
- [x] packages/db:Seed 脚本(建默认用户 + agent + 房间)
- [x] apps/web:API 路由在调 agent-runtime 前先持久化用户消息
- [x] apps/web:API 路由在流式完成后持久化 agent 消息
- [x] apps/web:页面加载时读历史

**已验证**:刷新后消息仍在

### Milestone 4:房间 ✅
依赖:Milestone 3

- [x] 房间列表页
- [x] 新建房间 UI
- [x] 房间详情页带聊天
- [x] 各房间消息历史独立
- [x] 每个房间绑一个 agent
- [x] 房间切换

**已验证**:建两个房间,消息互相隔离

### Milestone 5:认证 ✅
依赖:Milestone 3

- [x] Auth.js + credentials provider
- [x] 登录页
- [x] 注册页
- [x] API 路由加 session 校验
- [x] 房间与用户关联
- [x] 只显示用户自己的房间(通过 room_members 成员资格)

**已验证**:两个用户(binqiu、bob)分别登录,各自只看到自己的房间

### Milestone 6:房间摘要 + 用户记忆 ✅
依赖:Milestone 3

- [x] services/memory-worker:BullMQ 消费者
- [x] apps/web:聊天完成后 push 任务到 BullMQ(pushMemoryJobs 在 stream.ts)
- [x] memory-worker:生成房间摘要任务(阈值 = 20 条新消息)
- [x] memory-worker:用户记忆抽取任务(通过 JSON 模式产出 CRUD actions)
- [x] 持久化摘要和记忆到数据库
- [x] apps/web:把 summary + memory 作为 context 传给 agent-runtime
- [x] agent-runtime:使用传入的 context 组装 prompt(system prompt 在 web 侧构造,messages 数组传入)

**已验证**:agent 跨会话能记住用户的 fact;消息数过阈值时摘要重新生成

---

## Phase 1 milestone 依赖图
```
M0 → M1 → M2 → M3 → M4
                  ↓      ↘
                  M5      M6
```
M4、M5、M6 都依赖 M3,彼此独立

---

## Phase 2 — Agent 架构升级

目标:从"记忆永远注入"改成"基于工具、按需检索"。给用户(和 agent)一个纠正和遗忘 fact 的方法。

### Checkpoint A — 记忆安全基础 ✅
- [x] A1:`user_memories` schema 扩展(source / deleted_at / last_reinforced_at)+ migration
- [x] A2:读路径过滤软删记忆(`context.ts`)
- [x] A3:memory-worker 尊重墓碑 + `source='user_explicit'` 锁(prompt + 代码 + SQL)
- [x] A4:"我的记忆"管理 API + `/memories` 页面;用户编辑把 source 翻到 `user_explicit`

### Checkpoint B — Tool-calling 基础设施 ✅
- [x] B1:agent-runtime 工具循环(SSE tool_call/result 事件、JWT 透明透传、最多轮数)
- [x] B2:`POST /api/agent/tool` JWT 验签分发 + `toolRegistry`
- [x] 顺手修:`packages/logger` 惰性读 `LOG_DIR`,非 root 部署也能用

### Checkpoint C — 按需检索 ✅
- [x] C1:五个工具 —— `search_memories`、`search_messages`、`remember`(bigram dedup)、`update_memory`、`forget_memory`
- [x] C2:`buildSystemPrompt` 只 pin identity + high importance;`stream.ts` 签 JWT 并把工具发给 agent-runtime
- [x] 用真实 DeepSeek 端到端验证:forget 流程在多轮工具调用 + 多语言下都 work

### Checkpoint D — 检索加固
- [ ] D1:`messages.content` 的 `pg_trgm` GIN 索引,配合 `search_messages`;后续可以考虑 zhparser + tsvector 做中文全文
- [ ] D2:系统化记忆去重 —— embedding + pgvector,或定期 cron 对近重复 pair 用 LLM 合并

### Checkpoint E — 稳定化
- [x] CHANGELOG + TASKS 都更新到位
- [ ] `remember` 的线上 smoke test(当前一轮只端到端跑过 forget)
- [ ] 考虑加 evaluation harness,让 Phase 2 回归可见(现在只能手动流程)

### Phase 2 延后项
- [ ] MCP 支持 —— 有真实第三方工具需求再做
- [ ] Prompt versioning(`packages/prompts`)—— 遇到第一次 prompt 回归或 A/B 需求再做
- [ ] Memory-worker mock / offline 模式 —— CI 或共享机器开发有需求再做

---

## 动态记忆

目标:给记忆一个时间维度,让它可以演化 —— 单次事件带绝对时间戳,反复提及强化,不再被用到的衰减,反复出现的事件聚合成更高阶的语义 fact

### Phase A — 时间 + 强化 + 衰减 ✅(2026-04-19)
- [x] Schema `0007_memory_temporal.sql`:`user_memories.event_at timestamptz`、`user_memories.strength real DEFAULT 1.0`、`user_memories_event_at_idx` 部分索引服务时间范围检索
- [x] Agent prompt Layer 1b:`Current time: YYYY-MM-DD HH:mm Weekday (Asia/Shanghai)`,相对时间短语用它作锚点
- [x] 抽取 worker:每条消息带 `[时间]` 前缀 + Current time banner;对时间敏感的 CREATE 强制带 `eventAt`;content 禁止相对时间短语;瞬时状态("饿了"/"累了")必须 SKIP
- [x] **近似重复 → REINFORCE,不是 skip**:worker 和 `remember` 工具在 Jaccard ≥0.55 时把对应行 `strength += 1 + last_reinforced_at = now()`(locked/pending 行仍走 skip)
- [x] `search_memories`:`from` / `to` ISO 参数 → 时间窗检索,按 `event_at DESC` 排,结果包含 `event_at`
- [x] `search_messages`:对称的 `after` 参数(与 `before` 对应)
- [x] 读侧排序:`MEMORY_SCORE_SQL = strength × importance_weight × exp(-age_days/30)`,`getUserMemories` 和 `getRoomUsersMemories` 都用
- [x] `infra/update.sh` 幂等应用 0007
- [x] 文档:`CHANGELOG.md` 对应章节 + `docs/memory-system.md` §15

### Phase A 后续补丁 ✅(2026-04-19)
- [x] `buildLLMMessages` 给最近的 user 消息加 `[YYYY-MM-DD HH:mm]` 前缀;>6h 间隔在 system prompt 末尾加 gap note。assistant 消息**不**加前缀(避免 LLM 模仿格式把时间戳吐在回复开头)
- [x] `search_memories` 读侧强化:对命中行异步 `UPDATE user_memories SET last_reinforced_at = now()`。`strength` 故意不碰 —— 读取只移动衰减锚点
- [x] UI:聊天消息时间戳 + 日期分隔线;侧栏按 `lastActivityAt` 排序(API 相关子查询 + `room-activity` UserEvent);重排时 FLIP 动画
- [x] 跨浏览器兼容:`globals.css` 里 `@supports not` 的 oklch 兜底、`<html>` 挂 `data-theme="dark"`、Viewport 带 `colorScheme: "dark"` —— 修华为 / 旧 Chromium 的"白侧栏"
- [x] 存量数据 CLI:`pnpm backfill-event-at`(LLM 辅助的 event_at 填充)和 `pnpm strip-numbered-prefix`(正则清理旧编号列表残留)
- [x] `update.sh`:用 POSIX `.` 替代 `source`;加自我修改脚本的护栏(`exec "$0"` 重启后再执行余下步骤)

### Phase B — Consolidation(反复事件 → 语义)
- [ ] 周期性 worker 任务:聚类同用户、`category='event'`、content 相似、`event_at` 分散的行(≥3 次 occurrence 在可调窗口内)
- [ ] LLM 判这个簇是否代表一个模式;如是,产出语义 fact("经常不吃午饭"),`importance='medium'`,原 event 保留做证据
- [ ] 门槛:等 Phase A 有 ≥2 周真实强化数据,聚类阈值用数据调而不是拍脑袋

### Phase C — 衰减阈值 + 参数调优
- [x] `search_memories` 读一次 bump `last_reinforced_at`(Park et al. 原文语义 —— 检索强化 recency)
- [ ] Pinned 注入的硬阈值截断(当前只是排序靠后,有每用户 8 条上限兜底,没有 score 阈值)
- [ ] 在观察数据上调 `DECAY_HALFLIFE_DAYS` 和 importance 权重

---

## 下一个主任务
D2(pgvector 语义去重)是下一块最大的地 —— 不做的话 Phase A 的 reinforce 信号会在同义改写("喜欢甜食" vs "爱吃蛋糕")上被打散到多条记忆,而不是集中到一条;同时它是 Phase B 的前置(consolidation 需要干净的去重底座)。Phase B 本身还要等 ≥2 周真实强化数据
