# Agent Platform

一个多人 AI Agent 聊天平台：用户可以在房间里和 AI Agent 一起聊天，房间支持邀请好友、持久化历史、长期记忆，未来会扩展到语音和实时音视频。

> 当前版本：**v0.0.2** ｜ Phase 1（文本 MVP）已完成，正在准备进入 Phase 2。

---

## 已实现功能

- **多人聊天室** —— 创建房间、邀请好友、和 Agent 同处一室对话
- **好友系统** —— 邮箱加好友，自动共享房间
- **邀请码注册** —— 管理员生成邀请码，控制注册入口
- **流式回复** —— LLM 通过 SSE 实时流式输出
- **图片消息** —— 浏览器端压缩后直传腾讯云 COS，仅广播不触发 LLM
- **实时事件** —— Socket.IO 网关推送消息和"正在输入"
- **Agent 记忆** —— BullMQ 异步生成房间摘要 + 抽取用户长期记忆
- **多层 Prompt 组装** —— Agent 身份 / 房间规则 / 用户记忆 / 房间摘要 / 最近消息 / 当前输入
- **Agent 行为控制** —— 可关闭自动回复、@ 触发回复
- **房间管理** —— 自动命名、归档、删除
- **结构化日志** —— 各服务统一 JSON 日志，支持按 roomId 跨服务追踪
- **移动端适配** —— DaisyUI 响应式抽屉侧边栏 + 滑动手势

---

## 技术栈

- **前端**：Next.js（App Router）+ React + Tailwind CSS + DaisyUI
- **后端**：Next.js API Routes + Fastify（agent-runtime）
- **实时网关**：Socket.IO（realtime-gateway）
- **数据库**：PostgreSQL + Drizzle ORM
- **队列**：BullMQ + Redis
- **认证**：Auth.js（credentials provider，JWT）
- **LLM**：OpenAI Node.js SDK（兼容 DeepSeek 等）
- **对象存储**：腾讯云 COS（图片消息）
- **进程管理**：pm2
- **反向代理**：Caddy

---

## 仓库结构

```
apps/web/                  Next.js 前端 + API 路由
packages/db/               Drizzle schema + migrations
packages/types/            共享 TypeScript 类型
services/agent-runtime/    Fastify LLM 服务（SSE 流式）
services/memory-worker/    BullMQ Worker（房间摘要 + 记忆抽取）
services/realtime-gateway/ Socket.IO 实时网关
infra/                     Docker Compose、部署脚本、Caddyfile
```

---

## 本地开发

### 环境要求
- Node.js 22+
- pnpm 9+
- Docker（用于跑 PostgreSQL 和 Redis）

### 启动步骤

```bash
# 安装依赖
pnpm install

# 启动 PostgreSQL + Redis
cd infra && docker compose up -d && cd ..

# 准备环境变量
cp .env.example .env
# 编辑 .env 填入 LLM API key、数据库 URL 等

# 推送数据库 schema
cd packages/db && pnpm db:push && cd ../..

# 可选：种子数据
cd packages/db && pnpm db:seed && cd ../..

# 一键启动所有服务
pnpm dev
```

### 服务端口

| 服务 | 端口 | 说明 |
|---|---|---|
| web | 3000 | Next.js 前端 + API |
| agent-runtime | 3001 | Fastify LLM 流式代理 |
| realtime-gateway | 4000 | Socket.IO 实时网关 |
| memory-worker | — | BullMQ 后台 Worker |

---

## 生产部署

### 服务器要求
Ubuntu + Docker + Node.js 22+ + pnpm + pm2

### 首次部署

```bash
git clone https://github.com/ivybug-test/agent-platform.git ~/agent-platform
cd ~/agent-platform/infra
cp .env.prod.example .env.prod
# 编辑 .env.prod 填入真实值
chmod +x setup-server.sh
bash setup-server.sh
```

### 日常更新

```bash
cd ~/agent-platform
bash infra/update.sh
```

### 改了 web 代码后快速重建

```bash
bash infra/rebuild-web.sh
```

该脚本会：构建 web → 把 static / public 拷进 standalone → `pm2 restart web`。

### 部署要点
- PostgreSQL 和 Redis 走 Docker，Node 服务全部 pm2 直跑
- `.env.prod` 里的 `AUTH_URL` 必须和实际访问 URL 一致（包含协议）
- Next.js standalone 必须把 `static` 和 `public` 拷进去，否则资源 404
- pm2 启动 web 时 `cwd` 必须设到 standalone 目录内（见 `infra/deploy.sh`）
- 改 `NEXT_PUBLIC_*` 必须重新 `pnpm build`，dev hot reload 不会生效

---

## 开发进度

### Phase 1：文本 MVP ✅ 已完成
- M0 规划 / M1 monorepo 骨架 / M2 最小聊天链路（SSE 跑通）
- M3 数据库 + 消息持久化 / M4 房间 / M5 认证
- M6 房间摘要 + 用户记忆（BullMQ 异步抽取，6 层 Prompt 组装）
- 增量功能：图片消息、Socket.IO 实时事件、好友系统、邀请码注册、移动端适配、结构化日志、Context dedup（CJK 安全的 bigram 相似度去重）

### Phase 2：Agent 架构升级 🚧 即将开始
- Tool calling
- MCP（Model Context Protocol）支持，接入第三方工具
- 把"用户记忆"从永远注入改成按需调用的检索工具
- Prompt 版本管理（可能抽出 `packages/prompts`）
- 必要时评估是否迁移到 Python Agents SDK

### Phase 3：语音
- Realtime 语音输入 / 输出
- 打断支持
- 语音会话持久化

### Phase 4：RTC / 视频
- 多人音视频房间
- Agent 作为房间参与者
- 房间事件与在线状态

详细 milestone 拆解和已完成项见 [`CHANGELOG.md`](./CHANGELOG.md) 和 [`TASKS.md`](./TASKS.md)。

---

## 非目标（MVP 阶段不做）
视频聊天、RTC 基础设施、自主多 Agent 辩论、计费、复杂审核后台、大规模知识库导入、移动 App、插件市场。

---

## 环境变量
完整列表见 `.env.example` 和 `infra/.env.prod.example`。

## License
Private
