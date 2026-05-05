# 重构后的体验修复计划

> 目标：重构（`docs/refactor-plan.md`）结束后，按这里的优先级修体验问题。
> 全部问题主要在手机端暴露。
>
> 每条都是 **现状 → 根因假设 → 修复方案 → 验证 → 估计**。
> 修复方案里如果有多种路线，我会标 **A/B/C** 并给推荐。

## 关键决策记录

讨论后达成的共识，避免后续反复：

1. **不做** 3 步法（思考 → 工具调用 → 回答）。延迟 ×3、token ×3，不是业界做法，多轮工具扩展性差。多步架构（LangGraph、AutoGen planner-executor）是给"研究公司写报告"这种复杂任务用的，不是给"记得调一下 speak"用的。
2. **主防线** 是前置 intent router + 强制 `tool_choice` —— 在 OpenAI 协议层就断掉模型"只写文字溜过去"的退路，比 prompt 约束有效得多。这是 OpenAI/Anthropic 官方推荐的标准做法。
3. **当前 hallucination-detector 退居兜底**，不再是主防线。Router 命中之后基本轮不到它出场。
4. **Router 会误调，但比当前情况好**。误调可见可恢复（用户看见出来一张不想要的图），假装调用 / 空气泡不可见（用户只看见东西坏了）。用"高精度短语 + 否定前瞻 + 用户纠错回路"把误调率压到 < 5% 即可。
5. **speak / generate_image 是副作用工具**——工具结果不影响要写什么。模型训练直觉里没有矛盾点纠正它，所以 prompt 约束在这类工具上格外不靠谱。Issue 2 的 B1 子问题就是这个特性带来的 —— 副作用工具调完不需要补文字气泡。
6. **核选项**：如果 router + 兜底都不够，就**只在 routing 这一个点上**换 Haiku 4.5（一次小 call 做二分类），主对话仍然 DeepSeek。你只在这一个点需要 tool-use 纪律，整体换模型是过度反应。

---

## P0 — 决定性影响可用性的

### 1. Agent 说调了工具但没调

**现状**
- 单次 LLM call，`tool_choice="auto"`，模型可以自由地交替输出 `content` 和 `tool_calls`。
- `services/agent-runtime/src/routes/chat/tool-loop.ts:140-217` 做的是 **post-validation**：
  正则 (`hallucination-detector.ts`) 检查 `assistantText` 里是否出现了 `🔊 / 听语音版 / 画着呢 / 稍等十几秒 ...` 这类"假装调过工具"的语言；命中且对应 tool 没真实调用 → 让客户端撤回（`content_retracted`）+ 重跑这一轮，强制 `tool_choice = {function: name}`。重试上限 1 次。
- 正则覆盖范围窄（只覆盖 `speak` / `generate_image`），并且只能事后救火。
- web 层有"招1"钩子（`tool-loop.ts:74`）支持 per-request 强制 tool_choice，但**当前没人用**——前置路由从未真正搭起来。

**根因假设**
- DeepSeek-v4-pro tool-calling 纪律不如 GPT-4 / Claude（差 5-10×）—— 经常先把"答案"写出来再决定要不要调工具。
- prompt 里那串 `**CALL THE TOOL FIRST, THEN write text**` 大写规则是 prompt-only 约束，模型不一定服从。
- speak / generate_image 是**副作用工具** —— 工具结果不影响要写什么。模型从训练数据里学到的"先想要说啥，再说出来"的习惯在这里没有矛盾点纠正它。它写"听语音版~"然后忘了调 speak，是它觉得**已经说完了**。这是和模型训练直觉作对的设计。

**业界做法对照**
- **选更强的模型**（GPT-4o / Claude Sonnet 4.5）—— 最有效但成本高
- **强制 tool_choice + 前置路由** —— OpenAI/Anthropic 官方推荐，最普遍 ← 我们走这条
- Post-validation + 重试 —— 当前在做的，留作兜底
- 微调 —— 高频高价值场景才值得

**协议层保证（这是 router 有效的根本原因）**

传 `tool_choice: {type: "function", function: {name: "generate_image"}}` 时，模型在 OpenAI 协议层就被**强制**要 emit 这个 tool_call —— 它没法只写文字溜过去。不是"求"模型调工具，是断了它"不调"的退路。

---

#### 修复方案 A（主修复）：前置 intent router

`apps/web/src/app/api/chat/route.ts` 进入 agent-runtime 之前，对用户消息跑触发词路由，命中就设 `requestedToolChoice = {function: name}` 塞进 runtime body。runtime 侧的钩子已经在（`tool-loop.ts:74` 的"招1"），web 层填上字段即可。

实施分三阶段，按效果决定要不要做后面的：

**阶段 1：高精度正则 + 否定前瞻（半天，第一步上线）**

- 不要写裸的 `画` / `唱` / `说`。写**短语级**：

  ```
  generate_image:
    画一[张个幅副]|画[只个张]?[小]?(猫|狗|...|图|画)
    |帮我画|来一张|给我[看画一]|draw\s+me|paint\s+a

  speak:
    念一[下遍段]|读一[下遍段]|说一[句段下]
    |唱一[首段下]|哼一[段曲]|唱.{0,4}给我听
    |学.{0,3}(叫|声音)|模仿.{0,4}声音|用语音
  ```

- **否定 + 时态前瞻**：匹配前向看 8 个字符，命中以下任一就**否决**：
  ```
  不|别|不要|不用|拒绝|刚才|上次|之前|刚刚|刚画|那张
  ```
  例：`"别画了"` → 看到"别"在"画"前 → 不强制。

- **DeepSeek pro 模式注意**：forced tool_choice 在 pro 下偶发不稳定（reasoning_content 跟 forced 工具有奇怪交互）。router 命中时一并把 `mode` 降到 `flash` —— 强制工具的场景一般也不需要深度思考。

**阶段 2：用户纠错回路（小投入，做完阶段 1 顺手）**

- router 强制工具时记 flag 到响应 metadata。
- 如果用户**下一句**是 `"我没让你画" / "停" / "别画" / "我没让你说话"`（同样用正则识别），这一轮**禁用 router**，直接 auto。
- 廉价的"用户反馈学习" —— 不需要长期存储，只看最近一两轮。

**阶段 3（可选 · 上线后看效果决定）：Haiku 分类器**

- 如果阶段 1+2 上线一周后误调率仍 > 10%，加这一层。
- 正则做候选筛选；Haiku 4.5 一次小 call 做最终判断：
  ```
  system: 判断用户最新一句话是否在请求 [画图 / 发声 / 都不]。只输出 JSON: {tool: "generate_image"|"speak"|null}
  user:   <最近 1-2 轮对话>
  ```
- 成本 < $0.001/turn，延迟 +300-500ms，准确率显著高于纯正则。
- **核心思路**：你只在 router 这一个点上需要 tool-use 纪律，主对话纪律差点没关系。所以**只换 routing 模型，不换主模型**。

---

#### Router 风险评估：会调错吗？

会，但**误调比当前"假装调用 / 空气泡"更可恢复**——用户看得见 router 调错（出来一张不想要的图），但看不见模型偷懒（神秘空气泡）。

**典型误判 case**：

| 用户输入 | 朴素正则会怎么干 | 实际意图 | 阶段 1 是否挡住 |
|---------|------------------|----------|-----------------|
| "我不想画了" / "别画了" | 强制 generate_image | 取消 | ✅ 否定前瞻挡住 |
| "他是个画家" | 强制 generate_image | 在聊人 | ✅ 短语模式不匹配 |
| "你刚才画的那张图我喜欢" | 又画一张 | 评价已有图 | ✅ "刚才"前瞻挡住 |
| "学校不让画画" | 画一张 | 在叙述 | ✅ "不"前瞻挡住 |
| "唱片公司" / "学校" | speak | 名词 | ✅ 短语模式不匹配 |

**阶段 1 的"高精度短语 + 否定前瞻"已经把绝大多数挡掉**。剩余漏过的都落到原来的 auto 行为，最差也不会比现在更糟。

**激进度取舍**：
- **generate_image**：误调成本低（用户忽略就行，图 20s 出完不影响主流程），可以**更激进**地路由。
- **speak**：误调成本高（移动端公共场合突然播音），需要**更保守**。规则只覆盖最显式的（"念一下"、"读出来"、"用语音"），其余全部走 auto。

---

#### 修复方案 B（辅修复 · 兜底）：扩大 hallucination-detector 覆盖

router 上线后这块不再是主防线，但留着兜底高 ROI。
- 现在 `hallucination-detector.ts:11,17` 的正则枚举太手工。补：
  - 表情：`📷 📸 🎨 🖼️ 🎤 🎙️ 🔉` 等
  - 句式：`帮你画了 / 画完了 / 给你来一张 / 来听听 / 试试这个 / 我念一下`
- 长期：换成"小 LLM 判断" —— 给一个 system prompt "判断这段话是否预设了某个 tool 已经调过"。命中再走 force-retry。

#### 修复方案 C：max-rounds 兜底

- `tool-loop.ts:314-317` 现在 max-rounds 命中只发 `error` 事件，没给用户回复。补一个 final synthesis：把 `messages` 喂给一个 no-tool LLM call，强迫它给出收尾文本。

---

**验证**
- 阶段 1 上线后，建一个标注集（30 条手工 case：明确画图 / 明确发声 / 不该调 / 边界 / 否定）跑准确率。目标：**精确率 ≥ 95%**（不该调时不调）、**召回 ≥ 80%**（该调时调）。
- 上生产观察一周，记录每次 router 命中是否真实合用户意图。如果误调率 > 10% 再上阶段 3。
- 新加 e2e 脚本固化 hallucination 用例：发"画只猫" → 必须有 generate_image tool_call；发"喵两声" → 必须有 speak tool_call。

**估计**
- 阶段 1（高精度正则 + 否定前瞻）：**0.5d** ← 最先上，单文件改动，回滚成本零
- 阶段 2（用户纠错回路）：0.5d
- 阶段 3（Haiku 分类器）：1d（看上线效果决定要不要做）
- B 扩大正则：0.5d
- C max-rounds 兜底：0.5d

---

### 2. Agent 回答经常是空（深度思考能看到思考过程，但没回答）

**两个不同的 sub-case，根因和修法都不一样，要拆开做。**

#### B1：副作用工具调完没补文字 —— 其实**不是 bug**，是渲染逻辑错了

speak / generate_image 是副作用工具，**音频按钮 / 图片本身就是回复**。模型这一轮调完工具 → 没补文字 → 这是**正确行为**。但前端目前留了一个空的 agent 文字气泡，看起来像 bug。

**修复**
- `apps/web/src/lib/chat/stream.ts:336-344` 持久化时，如果 `fullContent === ""` **且**（`audioPayload` 存在 或 `image-pending` 已经创建）：
  - **不要 create 这条 agent 文字消息**（或写 status='completed' + content=null + 渲染层跳过）。
- `ChatPanel.tsx:488-504` 的本地 streaming 气泡：流结束时如果 content 仍然是空、但本轮已经收到了 speak/img 的 `tool_result`，把这个空文字气泡**清掉**。音频按钮 / 图片本身就是回复了。
- **注意**：清掉的判断要看"工具副作用是否成功"，不是"是否有 tool_result"。tool_result.ok=false（生成失败）时还是要保留文字气泡显示错误信息。

#### B2：reasoning 跑完没出 content —— 真 bug

`tool-loop.ts:142-169` 现在的兜底**只覆盖第一轮 reasoning 完没东西**。没覆盖：
1. 工具调用了，tool_result 回来后那一轮（应该输出最终答案的轮）text 又是空。
2. `forceToolChoice` 重试后，tool 调完进入下一轮，模型仍然不出文字。
3. 流中途因网络 / 上游错误断开（`tool-loop.ts:323-326` 的 catch 只发 `error`，不补回答）。

**根因假设**
- DeepSeek-pro 在工具调用回来后那一轮，把全部 budget 用在了 `reasoning_content`（reasoning token 不计入 `max_tokens` 但有内部上限），可见 content 为空。
- 也可能是 finish_reason="length" 但 content 长度恰好为 0。

**修复**
- **服务端 final synthesis（必做）**：把"空 content 兜底"扩展到所有非工具轮。循环结束时若 `assistantText === ""` 且**没有工具副作用**（区分 B1） 且 总共已经发生过 reasoning 或 tool_calls，就跑一次 final synthesis（无 tools，flash mode，prompt 里加 `请基于上面的工具结果给用户一个简洁的回答`）。
  - 实现位置：`tool-loop.ts` 在 `done = true; break` 之前 / 之后判断一次。
- **客户端最终态校验（必做）**：SSE 读取循环结束后，如果当前 streaming 气泡 `content === ""` 且 `reasoning` 不为空 且 没有任何工具副作用，渲染一个 inline "重新生成" 按钮，不要留空气泡。
- **持久化层（必做）**：`lib/chat/stream.ts:336-344` 持久化时如果 `fullContent === "" && fullReasoning !== "" && 没有工具副作用`，把 status 置为 `failed` 而不是 `completed`，并写占位文本（`(空回复 — 可重试)`）。这样刷新历史也不会出现空气泡。

#### 观测（必做，先于修复）

`tool-loop.ts:319` 的 `llm.complete` 日志里追加：
- `assistantText.length`
- `roundCount`
- `toolCallCount`（区分 B1）
- `finishReason`
- `hadReasoning`

先看一周日志，搞清 B1 / B2 真实占比再决定优先级。如果 B1 占 90%（很可能），先修 B1 投入 0.5d 收益最大。

**验证**
- 故意让 prompt 引导模型"只思考不回答"测试 B2 兜底是否启动。
- 跑一个 100 轮 mock，断言 `messages` 表里 `status='completed' AND content='' AND 无工具副作用` 的行数为 0。
- 发"画只猫"看图片气泡出现且**不**伴随空文字气泡。
- 发"画只猫"但模拟生成失败（`ok:false`），确认错误文字气泡正常显示。

**估计**：B1 0.5d，B2 1d，观测 0.5d（合计 2d）。

---

### 3. 回答经常被截断

**现状**
- `services/agent-runtime/src/constants.ts:14` `CHAT_MAX_TOKENS = 4096`。
- `finish_reason` 没有被特殊处理 —— `tool-loop.ts:135-137` 只是记录最后一个 finish_reason 不做任何动作。

**根因假设**
- 大概率是 `finish_reason === "length"`：4096 tokens 撞顶。pro 模式下 reasoning 不算入但**模型自己也有上限**，长 markdown 回答确实可能撞 4096。
- 也可能：上游连接被中间代理掐断（CN VPS 出网到 DeepSeek 偶发）。

**修复方案**
- **A（必做）：检测 finish_reason 并续写**
  - `tool-loop.ts` 当前最后一轮 `finishReason === "length"` 时，向 `messages` push 一条 `{role: "assistant", content: assistantText}`，再 push `{role: "user", content: "继续"}`，再请求一次（同一轮内可以续 1~2 次）。续上的 content 直接 sendEvent 给前端拼接。
  - 上限 2 次续写，避免无限 loop。

- **B（配套）：放宽 `CHAT_MAX_TOKENS`**
  - 改到 8192。pro 经常给长答案。

- **C（观测）**
  - `stream.complete` 日志加 `finishReason`，看截断占比。

**验证**
- 让模型生成"3000 字的散文"，确认续写补全。

**估计**：半天。

---

### 4. 流式输出能看到内容，输出完直接变空气泡

**现状**
- 客户端在 `ChatPanel.tsx:488-504` 添加一个**没有 id** 的 streaming 气泡，content 用 `setMessages` 累加。
- SSE 结尾收到 `{done: true, messageId}` (`ChatPanel.tsx:522-526`) 把 messageId 加到 `seenIds.current`。但**这个气泡的 id 字段始终是空**！
- Socket 广播 `agent-message`（`stream.ts:348-360`）携带 `agentMsgId` 到达 ChatPanel 时（`ChatPanel.tsx:262-345`）：
  - 走完 `seenIds.has` 那一步是否会被去重，依赖于上面的"完成事件"是否先到。如果广播先到、`{done: ...}` 后到，**广播会被加成一个新气泡**（带 id），然后 streaming 的本地气泡（无 id）也还在 → **两个气泡重叠**。
  - 反过来，去重生效后，本地气泡保留，但本地气泡的 id 仍然是空 → 下次 `refetch`（切房间回来）从 DB 拉到的 messageId 不在 `seenIds` 里，会**再追加一遍**；如果此时 DB 里 content 因为问题 2/3 是空，就会出现"消失变空气泡"的视觉效果。

**根因假设**
- 强假设：本地 streaming 气泡缺 id；当 broadcast / refetch 触发新一轮渲染时，要么重复出现，要么旧气泡被无 id 的 React reconciliation 行为抹掉。
- 弱假设：第 2/3 个问题的副作用 —— DB 持久化的 content 是空的，refetch 后用空内容覆盖了。

**修复方案**
- **A（必做）：streaming 气泡及时绑定 messageId**
  - 在 `ChatPanel.tsx:520-526` 收到 `{done: true, messageId}` 时，**同时**给当前 streaming 气泡填上 `id: messageId`。然后 `seenIds.add` 才有意义。
  - 进一步：把 messageId 在 stream 起始时就发出来（修 `stream.ts` 在 controller 启动后 enqueue 一个 `{type: "agent-msg-id", id: agentMsgId}` 事件），这样从一开始就 id 对齐，避免 race。

- **B（必做）：refetch 不要覆盖正在 streaming 的气泡**
  - `ChatPanel.tsx` 的 refetch 路径里，对 `senderType === "agent"` 且 `id` 在某个 "in-flight set" 中的消息跳过（or 用本地优先 merge 策略）。

- **C（已在问题 2 修复中）**：DB 不再持久化空 content，所以 refetch 也不会拉到空消息覆盖。

**验证**
- 在浏览器 devtools 里 throttle network，发一条消息，看 broadcast / done 任意先后顺序，是否只渲染一个气泡且最终 content 完整。
- 切走再回来，看回复是否还在。

**估计**：1 天（含 race 排查）。

---

## P1 — 引用相关

### 5. 引用经常 LLM 看不到（特别是图片，查不到 image id）

**现状**
- `apps/web/src/lib/chat/context.ts:684-720`：
  - **只有 `m.senderType === "user"` 时**才会 emit `[图片#N (msgId=xxx)]` 标记（`context.ts:709-714`）。
  - agent 自己生成的图（`generate_image` 产出的 `contentType: "image"` 消息，`senderType: "agent"`）走 else 分支（`context.ts:720-`），**没有任何图片标记**。
- prompt 里 (`context.ts:354,355,443`) 教模型"通过 `[图片#N (msgId=xxx)]` 标记找图"，但 agent 自己画的图**永远拿不到这个标记**。

**根因 — 这是真正的 bug**
- 用户说"再改改你刚才画的那张图" → 模型在上下文里搜索 "图片#" 标记 → 只找到用户发的图 → 找不到自己画的 → "查不到图片 id" 现象。

**修复方案**
- **A（必做）：agent 自己的 image 消息也要 emit 标记**
  - `context.ts:684-720` 里把图片标记逻辑提取出来，对 `m.contentType === "image"` 的所有消息（user / agent 都算）都加上 `[图片#N (msgId=xxx)]`，N 共享同一个 imageSeq 计数器。
  - agent 的 image 消息标记可以特别注明来源，例：`[图片#3 (msgId=xxx) 你之前画的]`，让模型清楚这是它自己画过的。

- **B（必做）：image-pending 消息也要带标记**
  - 当前 `image-pending` 是占位符。如果一条 image-pending 还没解决就被纳入上下文（很罕见，但例如多轮对话里），同样要给标记。

- **C（配套）：read_image 工具支持 agent 画的图**
  - 检查 `apps/web/src/lib/tools/image-read-tools.ts`：read_image 应该能读自己生成的图。如果实现里只做了 user-uploaded 的处理，要补。

**验证**
- 跑流程："画一只猫" → "把它改成蓝色" → 看 agent-runtime body 里 messages 数组中 agent 那条 image 消息是否带 `[图片#N]` 标记。

**估计**：半天。

---

### 6. 引用跳转经常失效（可能跟 5 关联）

**现状**
- `ChatPanel.tsx:868-955` 的 `jumpToMessage`：
  - 未加载到的旧消息：每轮 `loadOlderMessages()` + 等 500ms，**最多 12 轮**（约 600 条消息往上翻）。再老就放弃。
  - 找到 DOM 后做 multi-pass 滚动定位，处理 `content-visibility:auto` 的 placeholder 高度问题。

**根因假设**
- 跳转到很老的消息（>600 条）必然失败。
- 模型可能拿了一个**根本不在本房间**的 messageId（跨房间 / 幻觉 ID）→ DOM 永远找不到。
- 如果引用的是图片消息（issue 5 修了之后会变多），placeholder 高度抖得更厉害，可能定位错位。

**修复方案**
- **A（必做）：扩大跳转上限 + 给用户反馈**
  - 12 轮提到 30 轮，且失败时弹 toast `这条消息太久远，未能定位` 而不是只 console.warn。

- **B（推荐）：服务端 messageId 校验**
  - 引用链路：模型输出 `[文字](msg:abc-123)` → 客户端点击 → `jumpToMessage('abc-123')`。
  - 增加一个 `/api/messages/[id]/locate` 端点：返回该 msgId 的 roomId + 在房间内的相对位置（第几条），客户端直接跳过去而不是逐页 loadOlder。
  - 这一步同时解决"模型引用了别的房间的 msgId"问题（直接报错"该消息不在本房间"）。

- **C（关联 5）：图片消息的 contain-intrinsic-size 调大**
  - `MessageBubble.tsx:63` 现在写死 `auto_120px`。图片消息（contentType=image）改成 `auto_300px`，减少 multi-pass 滚动需要的迭代次数。

**验证**
- 给 agent 一段 1000 条历史的房间，让它引用第 500 条，看是否能跳转到。
- 引用一个不存在的 msgId，看 toast 出现。

**估计**：1 天（B 是大头）。

---

## P2 — 移动端体验

### 7. 手机端翻历史不平滑（卡顿、时快时慢）

**现状**
- `MessageBubble.tsx:63` 用 `content-visibility: auto; contain-intrinsic-size: auto 120px;`。气泡进入 viewport 时从 120px placeholder 展开到真实高度（实际 60-600px），布局抖动。
- `ChatPanel.tsx:367-377` 监听 scroll，`scrollTop < 80` 触发 `loadOlderMessages` —— 没有节流，纯靠 `isLoadingMore` 状态防重复，但 setState 异步，连续滚动事件可能错过。

**修复方案**
- **A（必做）：移动端关闭 content-visibility**
  - `content-visibility:auto` 在 mobile Safari 上长列表时常出现重排抖动。改成媒体查询：移动端走传统渲染，桌面端保留 `content-visibility:auto`。
  - 折中方案：用 IntersectionObserver 手动控制 `contain-intrinsic-size`，让已经渲染过一次的气泡保持真实高度作为 hint。

- **B（必做）：loadOlderMessages 节流 + 锚点保留**
  - 触发条件加防抖：连续滚动 200ms 内只触发 1 次。
  - 加载完成后用 anchor scroll：记录加载前最顶部消息的 DOM 偏移，加载新数据后强制把视口对齐到那个 DOM —— 防止"滚到底了页面跳一下"。
  - 实现示例：`scrollHeightBefore = container.scrollHeight; await load(); container.scrollTop += container.scrollHeight - scrollHeightBefore;`

- **C（必做）：去掉 React 不必要的 re-render**
  - 检查 `MessageBubble` 的 `React.memo` 是否真的生效（props 引用稳定吗？`onClick`、`replyTo` 之类如果每次都新建对象会破 memo）。
  - 用 React DevTools Profiler 看 scroll 时哪些组件 re-render。

**验证**
- iPhone Safari + Android Chrome 真机测，滚动 1000 条历史时记录 FPS（dev tools → performance）。目标 ≥ 50 fps 平均。

**估计**：1.5 天（B 是大头，要小心做对锚点）。

---

## P3 — UI 体验

### 8. 侧边栏"房间共享事实"功能多余

**现状**
- `Sidebar.tsx:179-189` 在房间右键菜单里有 "房间共享事实" 入口，点开 `RoomSettings` modal。

**修复方案**
- **A**：从 sidebar 菜单里移除该项。
- **B**：保留 `RoomSettings` 整体（可能里面还有其他东西，比如 system_prompt 编辑）。如果"共享事实"是 RoomSettings 唯一内容，就把整个入口挪到房间内的标题栏（更符合"在房间里管房间"的习惯）。

需要先确认 `RoomSettings` 当前包含哪些功能再决定是删菜单项还是删整个组件。

**估计**：0.5 小时（如果只是删菜单项）。

---

### 9. 自动回复开关不应该跟归档/删除放在一起

**现状**
- `Sidebar.tsx:170-201` 房间右键菜单里 "自动回复 / 房间共享事实 / 归档 / 删除" 四个并列。
- 自动回复是高频切换（每聊一次可能改一次），归档/删除是低频破坏性操作，混在一起既不方便又危险。

**修复方案**
- **A（推荐）**：把"自动回复"开关移到聊天界面顶栏（房间标题旁边），用一个小的 switch / chip。
  - 涉及文件：`ChatPanel.tsx` 顶栏部分；可能要 lift 一个 onToggleAutoReply prop 上来。
- **B**：sidebar 菜单只保留破坏性操作（归档 / 删除）。

**估计**：0.5 天（含 UI 调整）。

---

---

## P0 续 — 后续发现的 bug

### 10. Agent 流式回复和其他用户的消息粘连

**现状**
- 用户在群聊里看到：agent 正在流式输出，**期间另一个用户发了消息**，结果 agent 后半段的 token 拼到了那个用户的气泡里。

**根因（已在代码里定位）**

`apps/web/src/components/ChatPanel.tsx:570-584` 的 SSE `parsed.content` 处理：

```js
setMessages((prev) => {
  const updated = [...prev];
  const last = updated[updated.length - 1];   // ← 假设最后一条永远是 streaming 中的 agent 气泡
  updated[updated.length - 1] = {
    ...last,
    content: last.content + parsed.content,    // ← 拼到 last 的 content
  };
  return updated;
});
```

而 `ChatPanel.tsx:332-344` 的 socket 房间事件处理把**新消息直接 push 到数组末尾**：

```js
setMessages((prev) => [...prev, { id, senderType, content, ... }]);
```

**race**：agent SSE 流到一半 → 群里另一个用户发消息 → socket 把那条 user 消息 push 到末尾 → 现在 `prev[prev.length - 1]` 是**那个用户的消息** → 后续的 SSE chunk 把 agent 的字拼进了那条用户消息 → 视觉上"粘连"。

这个 bug 跟 Issue 4（streaming 气泡 id 缺失）共享根因 —— 都源于 streaming 气泡用"位置"（数组末尾）而不是"id"来识别。

**修复方案**

- **A（必做）**：streaming 气泡用 ref 跟踪 id，不要靠位置查找。
  - 进入流式时 `streamingMsgIdRef.current = msgId`（msgId 来自 `stream.ts` 起始时立刻发的 `agent-msg-id` 事件 —— 见 Issue 4 修复）。
  - 所有 `parsed.content / parsed.reasoning / parsed.tool_call` 处理改成按 id 查找：
    ```js
    setMessages((prev) =>
      prev.map((m) =>
        m.id === streamingMsgIdRef.current
          ? { ...m, content: m.content + parsed.content }
          : m
      )
    );
    ```
- **B（必做）**：socket "agent-message" 广播的插入位置也要避开 streaming 气泡 —— 或者用 id 去重（streaming 中的 id 应跳过）。
- **C（必做）**：测试覆盖 —— 写一个 e2e：开两个浏览器，A agent 流式时 B 发消息，断言 A 的 agent 回复完整且与 B 的消息分隔正确。

**与 Issue 4 的关系**
- Issue 4（"流完直接变空"）+ Issue 10（"和别人粘连"）合并成"streaming 气泡身份管理"一个修复 —— 把 streaming 气泡从"匿名 + 末尾"改成"id-based"，两个 bug 一起消失。
- 实施上当作同一个 PR 做。

**估计**：合 Issue 4 一起 1.5d（原 1d 的 4 + 0.5d 的 10）。

---

### 11. 偶发 generate_image 工具失败 / 图链路返回 NoSuchKey

**现状**（截图：`bb7dd41e-f0cc-4536-980f-8b2839e64f02.jpg`）
- 用户点开 agent 画的图，浏览器跳到 COS URL：
  `agentimage-1411620332.cos.ap-guangzhou.myqcloud.com/agent-images/<roomId>/<agentId>/202605/<uuid>.jpg`
- COS 返回 `NoSuchKey: The specified key does not exist`。

**关键观察**
- DB `messages.content` 里写的就是这个 COS URL（不是 provider 的 24h 临时 URL），说明 `image-tools.ts:286` 的 `uploadBufferToCos` 已经 await 完成、`db.update` 也写进去了。
- COS PUT 协议层成功（`server-upload.ts:139` 的 `res.ok` 必须 2xx 才返回 url），但 GET 该 key 返回 NoSuchKey。
- 用户描述是"偶发"。

**根因假设**（需要观测确认）
1. **Bucket lifecycle 规则误删**：bucket 配了"X 天后自动删除"。`agent-images/` 前缀下的对象被生命周期规则清掉。**可能性最大**——也最容易验证。
2. **PUT 成功但对象未持久化**：理论上不该发生，但若 COS 后端边缘节点有瞬态故障，可能出现"PUT 200 + GET 404"。腾讯云 COS 文档承诺新对象 read-after-write 强一致，所以这一条概率很低。
3. **CDN 负缓存**：如果 bucket 前面挂了 CDN，且某个 CDN 节点在 PUT 完成**之前**就被预热请求过（返回 NoSuchKey 被缓存），后续即使对象存在，该 CDN 节点仍返回 404 直到缓存过期。但截图里的 host 是直接 COS 域名（`*.cos.ap-guangzhou.myqcloud.com`），不是 CDN 域名，本路径**不应**有 CDN 缓存。
4. **Server-upload.ts 签名/路径 corner case**：URL 编码 mismatch。当前 keyPrefix 只含 UUID + 字面字符（无中文 / 空格），不会触发；可排除。
5. **手动清理 / 误删**：人工或脚本清理过 bucket。

**修复方案**

**A（必做 · 优先）：加可观测性**
- `server-upload.ts:138` PUT 成功后，**追加一次 HEAD 验证**：
  ```ts
  // 立即 HEAD 一次确认对象可读，否则报错回滚
  const head = await fetch(`https://${host}${pathname}`, { method: "HEAD" });
  if (!head.ok) throw new Error(`COS HEAD verification failed: ${head.status}`);
  ```
  把 PUT-then-HEAD 整体当成一个事务。如果 HEAD 失败，把 message 标记为 `image-failed` —— 比让用户点开看到死链好得多。
- 在 `image-tools.ts:283-326` 的 try/catch 里把 PUT 的 `upload.key` + `upload.url` 都打到 info 日志，方便事后查表对比 DB 和 COS 状态。
- 客户端图片 onError 时，上报一个 `image-broken` event 到 `/api/telemetry`，带上消息 id 和图片 URL。先把这类事件的频率量化出来。

**B（必做）：检查 bucket lifecycle 规则**
- 登录腾讯云 console → COS → `agentimage-1411620332` bucket → 生命周期管理。
- 如果有规则匹配 `agent-images/` 前缀，**删除规则或改成不删除**（agent 画的图理论上要永久保留——是聊天记录的一部分）。
- 如果有规则把图沉降到归档存储（COS 归档需要解冻才能访问），同样改掉。

**C（推荐）：客户端图片错误兜底渲染**
- `MessageBubble.tsx` 渲染图片时加 `<img onError={...}>`，触发后把气泡换成"图片已失效"占位 + "重新生成"按钮。用户体验上比"点开看见 NoSuchKey 文字"好太多。

**D（观察后再决定）：COS 写入前预 HEAD**
- 如果 A 的 HEAD 验证经常**首次失败、重试成功**，说明是 COS 的强一致性边缘 case，加重试 1 次即可。
- 如果 HEAD 总是失败，说明确实有删除发生，回到 B。

**验证**
- A 上线后，看 `imagegen.rehost-complete` 日志和 `image-broken` telemetry 比例。
- 上线一周内查不到 lifecycle 规则触发就排除假设 1。
- 复现：手动调用 generate_image，等待 1 小时，再点开图，HEAD 一次验证。

**估计**
- A（HEAD 验证 + 日志 + 客户端 onError 上报）：0.5d
- B（检查并清理 lifecycle 规则）：0.1d（纯运维操作）
- C（错误兜底渲染）：0.5d
- 合计 1d 内全部完成。

**优先级**：A + B 是 P0（影响功能可信度，用户看到死链直接觉得产品坏了）；C 是 P1（用户体验改善）。

---

## 总体执行顺序

| # | 标题 | 优先级 | 估计 | 依赖 |
|---|------|--------|------|------|
| 1a | router 阶段 1：高精度正则 + 否定前瞻 | P0 | 0.5d | 无 |
| 1b | router 阶段 2：用户纠错回路 | P0 | 0.5d | 1a |
| 1c | router 阶段 3：Haiku 分类器 | P1 | 1d | 1a 上线观察一周 |
| 1d | hallucination-detector 扩大覆盖（兜底） | P1 | 0.5d | 无 |
| 1e | max-rounds final synthesis 兜底 | P1 | 0.5d | 无 |
| 2-观测 | 加日志区分 B1/B2 占比 | P0 | 0.5d | 无 |
| 2a | B1：副作用工具不留空文字气泡 | P0 | 0.5d | 2-观测 |
| 2b | B2：reasoning 完空 content 兜底（服务端 + 客户端 + 持久化） | P0 | 1d | 2-观测 |
| 3 | 截断检测 + 续写 | P0 | 0.5d | 无 |
| 4 + 10 | streaming 气泡 id 化（解决"流完变空"+"和别人粘连"） | P0 | 1.5d | 2a/2b |
| 11a | COS PUT 后 HEAD 验证 + 日志 + 客户端 onError 上报 | P0 | 0.5d | 无 |
| 11b | 检查 / 清理 COS bucket lifecycle 规则 | P0 | 0.1d | 无 |
| 11c | 客户端图片错误兜底渲染 | P1 | 0.5d | 无 |
| 5 | agent 自画图带 msgId 标记 | P1 | 0.5d | 无 |
| 6 | 跨房间 messageId 定位 | P1 | 1d | 5 |
| 7 | 移动端滚动 | P2 | 1.5d | 无 |
| 8 | 删共享事实菜单项 | P3 | 0.1d | 无 |
| 9 | 自动回复开关换位置 | P3 | 0.5d | 无 |

**总计 ~10.5 人天**（1c 看效果决定要不要做）。

**推荐执行顺序**

1. **第零波（即刻 · 不写代码，0.1d）**：执行 **11b** —— 登录腾讯云 console 检查 bucket lifecycle 规则。如果是这条规则误删 → 当场关掉，存量问题缓解。
2. **第一波（最快见效，0.5d）**：上 **1a**（router 阶段 1）。单文件改动，风险极低，预期立刻消除 70% 的"假装调用"。
3. **第二波（0.5d）**：加 **2-观测** 日志 + **11a**（HEAD 验证 + 上报）。这两项都是先把"看不见的失败"变成"看得见的失败"，没修复但能量化。
4. **第三波**：根据观测数据决定 **2a / 2b** 顺序。如果 B1 占大头（很可能），优先 2a；如果 B2 占大头，优先 2b。
5. **第四波**：1b（用户纠错） + 1d（兜底正则） + 3（截断续写）+ **4 + 10**（streaming 气泡 id 化，一起做），互相加强且并行不冲突。
6. **第五波**：11c（图片错误兜底渲染） + 5 → 6（图片引用链路）。
7. **收尾**：7、8、9。
8. **观望**：1a 上线一周后看误调率，超过 10% 才上 **1c**（Haiku 分类器）。

**关键节点**：
- 1a 上线后立刻能感受到改善
- 4+10 合并修复后"粘连"和"流完变空"两个 race 问题消失
- 11a + 11b 后图链路死链问题量化并定位

这几个节点是体验回血的核心。

---

## 不在本计划里的事

- **不做**：3 步法（思考 → 工具调用 → 回答）—— 见问题 1 的分析。
- **不做**：完全切到 Python Agents SDK / LangGraph —— 当前架构问题不是 orchestration 复杂度，是 prompt + 兜底缺失。CLAUDE.md Phase 2 也写明"evaluate migration ... if orchestration complexity warrants it"，目前不到那个程度。
- **不做**：无限轮工具调用 —— 现有 `DEFAULT_MAX_TOOL_ROUNDS = 5` 够用。
- **不做**：把整个主对话换到 Claude / GPT-4 —— 过度反应。只在 router（1c）这一个点上需要 tool-use 纪律。
- **不做**：把 speak 改成纯前端按钮（用户点🔊触发 TTS，不走 LLM） —— 这条路更彻底但会丢掉"agent 主动决定要不要发声"的产品特性。Phase C 的产品定位还在演进，先用 router 修，等定位稳了再考虑结构性改动。

---

## 修完后的验证清单

每条都做完后，跑一次手机端真机回归：
- [ ] 发"画只猫" → 必有图片
- [ ] 发"喵两声" → 必有 🔊 按钮
- [ ] 触发深度思考 → 必有最终回答（非空气泡）
- [ ] 长回答（请它写 3000 字散文）→ 不被截断
- [ ] 流式完成后切走再回来 → 回答还在
- [ ] 让它"再改改刚才画的那张图" → 它能找到图片 id
- [ ] 引用跳转：恢复一条 800 条之外的旧消息 → 能跳到 OR 给出明确报错
- [ ] 1000 条历史滚动 → 不卡顿
- [ ] 房间菜单只剩归档/删除；自动回复开关在聊天界面
