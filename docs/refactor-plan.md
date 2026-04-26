# 重构计划

不紧急，记下来留着以后做。当前文件普遍偏长，prompt 字符串和 DB 查询、工具实现混在同一个文件里。下面四块按优先级排，前三块互不影响 UI、风险低，可以一次推一块。

## 现状统计（>200 行的文件）

| 文件 | 行数 | 核心问题 |
|---|---|---|
| `apps/web/src/components/ChatPanel.tsx` | 1602 | UI 巨石：消息渲染 + 输入栏 + voice 模式 + TTS 队列 + 引用 + 工具卡片 + 图片上传全在一个组件里 |
| `apps/web/src/lib/tools/memory-tools.ts` | 1095 | 12 个 memory 工具（search/remember/update/forget/relate/...）一个文件全包 |
| `apps/web/src/app/memories/page.tsx` | 1003 | UI 巨石（mine/pending/relationships 三 tab + add form 都在 page.tsx） |
| `apps/web/src/lib/chat/context.ts` | 652 | `buildSystemPrompt` 里 toolGuidance / capabilitiesLine / IMPORTANT RULES 三大段 prompt 字符串与 6 个 DB 查询函数糅在一起 |
| `apps/web/src/lib/tools/web-search-tools.ts` | 607 | 4 个工具 + 2 个 provider + cache + 限流 一锅 |
| `apps/web/src/app/me/page.tsx` | 546 | 多个独立卡片塞一个文件 |
| `services/memory-worker/src/jobs/user-memory.ts` | 501 | 抽取 prompt + LLM 调用 + dedup + DB 写一锅 |
| `services/agent-runtime/src/index.ts` | 444 | Fastify 路由 + 工具循环 + summarize 在一起 |
| `apps/web/src/lib/chat/stream.ts` | 350 | 单一职责，长但不乱，低优 |
| `services/memory-worker/src/jobs/memory-dedup.ts` | 329 | 单一职责，低优 |
| `services/memory-worker/src/cli/backfill-event-at.ts` | 320 | 一次性 CLI，不拆 |
| `packages/db/src/schema.ts` | 287 | schema 定义，长但合理，不拆 |
| `apps/web/src/components/Sidebar.tsx` | 276 | 长但合理 |
| `apps/web/src/components/RoomSettings.tsx` | 268 | 长但合理 |
| `apps/web/src/lib/audio/streaming-player.ts` | 266 | 单一职责（MSE 播放器），不拆 |
| `apps/web/src/app/page.tsx` | 228 | 不拆 |
| `apps/web/src/app/api/chat/route.ts` | 202 | borderline，不拆 |

## 拆分计划

### Phase 1: `lib/chat/context.ts` → 5 个文件 🔥 最易出价值

```
apps/web/src/lib/chat/
├── context.ts             # 仅留 loadChatContext + buildLLMMessages（保持现有 export）
├── system-prompt.ts       # buildSystemPrompt 主体（layer 拼装）
├── prompts/
│   ├── tool-guidance.ts   # 9 个工具说明的多行字符串
│   ├── capabilities.ts    # CAPABILITIES 段（看图 / 说话 / 搜索 / 记忆）
│   └── important-rules.ts # 编号 1-7 的 RULES 段
└── queries/
    ├── memories.ts        # getUserMemories / getRoomUsersMemories / formatUserMemories
    ├── room.ts            # getLatestSummary / getRoomMemories / getRoomMemberNames
    └── relationships.ts   # getConfirmedRelationshipsForUser
```

**收益**：改 prompt 不用碰逻辑代码；下次有人想改 toolGuidance 直接打开 `prompts/tool-guidance.ts` 就行。

**风险**：纯后端文件移动 + import 路径调整，typecheck 通过 = 安全。

### Phase 2: `memory-tools.ts` → 一工具一文件 🔥

```
apps/web/src/lib/tools/memory/
├── index.ts               # 聚合 + 导出 memoryToolHandlers + memoryToolDefs
├── _helpers.ts            # textSimilarity / parseEventAt / clampLimit
├── search-memories.ts
├── search-messages.ts
├── remember.ts
├── update-memory.ts
├── forget-memory.ts
├── confirm-memory.ts
├── relate.ts
├── unrelate.ts
├── search-relationships.ts
└── room-memory.ts         # 3 个 room-fact 工具一组（search_room_memory / save_room_fact / forget_room_fact）
```

**收益**：每个工具的 handler + def 在自己文件里，定位 / 修改 / 改 description 一目了然。新加工具不用 scroll 1000 行找位置。

**风险**：低，纯文件拆分。

### Phase 3: `web-search-tools.ts` → provider / 工具分离 🔥

```
apps/web/src/lib/tools/web/
├── index.ts               # 聚合 + 导出 webSearchToolHandlers + webSearchToolDefs
├── _run-search.ts         # 共用的 runSearch + 限流 + cache
├── providers/
│   ├── bocha.ts
│   └── tavily.ts
├── web-search.ts
├── search-lyrics.ts
├── search-music.ts
└── fetch-url.ts           # Tavily extract 单独
```

**收益**：加新 provider（火山 / Bing / 百度）只动 `providers/`；调某个工具的 description 不影响其他工具。

**风险**：低，纯文件拆分。

### Phase 4: `ChatPanel.tsx` → 子组件 + hook 拆分（缓做）

```
apps/web/src/components/chat/
├── ChatPanel.tsx          # 主壳（state、SSE 循环、布局）— 目标 ~400 行
├── ChatMessage.tsx        # 单条消息（bubble + reply + 工具卡 + 长按菜单）
├── ChatInputDock.tsx      # 输入框 + 模型/语音 pill + 发送
├── ThinkingPanel.tsx      # 当前内联，提出来
├── ToolInvocationsCard.tsx# 当前内联，提出来
└── hooks/
    ├── useTtsQueue.ts     # 句子级 TTS 队列（refs + tryAdvanceTts）
    ├── useReplyTarget.ts  # 引用状态
    └── useImageUpload.ts  # 图片上传 + COS STS
```

**收益**：主组件从 1600 行 → ~400 行；每个 hook 独立可测；reply-quote / tool-invocation 这些功能模块可独立演进。

**风险**：**高**。
- 改动面大，单 commit 不容易 review
- 跟 reply-quote / 工具卡片这些进行中的 feature 可能撞车
- React state / ref 边界要小心，hook 抽出来要保证 closure 关系不变

**条件**：等 ChatPanel 上的活跃 feature（reply-quote、工具卡片渲染）稳定后再做，单独一个 PR。

### Phase 5: 其他次优先项（机会主义改）

- `services/memory-worker/src/jobs/user-memory.ts` (501) — 把 `buildExtractionPrompt` 移到 `prompts/user-memory-extraction.ts`，handler 主体瘦身
- `services/agent-runtime/src/index.ts` (444) — 拆成 `routes/chat.ts` + `routes/summarize.ts` + `tool-loop.ts`
- `apps/web/src/app/memories/page.tsx` (1003) — 三个 tab 各拆一个组件
- `apps/web/src/app/me/page.tsx` (546) — 各卡片提成 `<MeCard>` 子组件

这些不紧急，新加 feature 时顺手做。

## 推荐执行顺序

1. **先 Phase 1**（context.ts）— 一周内做一次，受益面最大（任何改 prompt 的人都能感知到）
2. **再 Phase 2 + 3**（两个 tools）— 同一周可以一起做，互不冲突
3. **Phase 4（ChatPanel）暂缓** — 等其他 feature 收敛后单独一周做
4. **Phase 5** 顺手 — 触碰相关文件时一并做

每个 Phase 一个独立 commit，commit message 写清"纯文件拆分，无逻辑变化"，方便 review + 回滚。
