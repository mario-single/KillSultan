# 刺杀苏丹王 KillSultan（MVP）

基于网页的多人实时身份推理游戏，核心玩法参考《刺杀苏丹王》。

## 我现在就想开一局

1. 安装 Node.js（建议 20+，最低 18+）。
2. 在项目根目录执行：

```bash
npm install
npm run dev
```

3. 打开浏览器：`http://localhost:5173`
4. 服务端健康检查：`http://localhost:3000/health`（看到 `{"ok":true,...}` 即正常）

如果你只想看更详细的新手步骤，请直接看 [docs/quickstart-zh.md](docs/quickstart-zh.md)。

## 第一局怎么开始

1. 房主打开 `http://localhost:5173`，输入昵称，点击“创建房间”。
2. 其他玩家输入昵称 + 房间号，点击“加入房间”。
3. 全员点击“准备”。
4. 房主点击“开始游戏”。

## 单机多人测试入口

如果你想在一个页面里模拟多玩家压力测试，打开：

`http://localhost:5173/?lab=1`

该实验台支持 5-15 名模拟玩家、全流程动作、断线重连与调试事件。

## 常用命令

- `npm run dev`：同时启动 shared 构建监听、服务端、客户端
- `npm run dev:server`：仅启动服务端（默认 3000）
- `npm run dev:client`：仅启动客户端（默认 5173）
- `npm run dev:shared`：仅监听 shared 包构建
- `npm run typecheck`：检查全部工作区类型
- `npm run docs:sync`：同步文档到客户端 `public/docs`
- `npm run docs:check`：检查文档是否已同步
- `npm run rulebook:docx`：从 Markdown 生成 DOCX 规则手册

## 可选配置（高级）

默认情况下不需要改任何配置即可本地运行。

- `PORT`：服务端端口，默认 `3000`
- `CORS_ORIGIN`：允许的客户端地址，默认 `*`
- `REDIS_URL`：配置后启用 Redis 存储；不配置则使用内存存储
- `VITE_SERVER_URL`：客户端连接服务端地址，默认 `http://localhost:3000`

仓库里有 `.env.example` 作为变量参考值。

## 常见问题

### 1. 页面打不开 / 连不上

- 确认 `npm run dev` 进程仍在运行。
- 打开 `http://localhost:3000/health` 看是否返回 `ok: true`。
- 确认 `http://localhost:5173` 可以访问。

### 2. 提示端口被占用（3000 或 5173）

- 关闭之前已经启动的同类进程后重试。
- 或改端口后再启动（例如先设置 `PORT` / `VITE_SERVER_URL`）。

### 3. 加入房间失败

- 房间号必须完全一致（建议全大写）。
- 游戏开始后不支持新玩家中途加入，仅支持原玩家断线重连。

## 文档体系

- `README.md`
  - 给第一次接触项目的人看，用来理解项目是什么、怎么启动、文档在哪里。
- [docs/quickstart-zh.md](docs/quickstart-zh.md)
  - 给想快速开一局的人看。
- [docs/玩家规则手册.md](docs/玩家规则手册.md)
  - 给玩家看，是正式规则口径。
- [docs/玩家规则手册.docx](docs/玩家规则手册.docx)
  - 玩家规则手册的 DOCX 版本。
- [docs/面向开发者文档.md](docs/面向开发者文档.md)
  - 给开发者看，说明宏观架构、实现方式与维护边界。
- [docs/核心机制接口文档.md](docs/核心机制接口文档.md)
  - 给开发者看，说明 `apps/core_rules` 与外围系统之间的接口约定。
- `apps/core_rules/`
  - 核心机制目录，默认由开发者 `zhz` 维护；除非 `lxh` 明确说明，否则不应随意改动。
- [docs/AI交接记忆库.md](docs/AI交接记忆库.md)
  - 给 AI 看，用来保存上下文和协作约定。
- [docs/lxhtodo.md](docs/lxhtodo.md)
  - 给开发者 `lxh` 自己看的计划文档。
- [docs/图片命名规范.txt](docs/图片命名规范.txt)
  - 规定工程中的图片资源命名方式。

## 项目结构

```text
apps/
  server/   # 服务端适配层（房间/Socket/广播）
  core_rules/ # Python 核心机制层（默认由 zhz 维护）
  client/   # 前端（React + Vite）
packages/
  shared/   # 前后端共享类型、规则与协议
docs/
  面向开发者文档.md
  核心机制接口文档.md
  AI交接记忆库.md
  quickstart-zh.md
  lxhtodo.md
  图片命名规范.txt
  玩家规则手册.md
  玩家规则手册.docx
```
