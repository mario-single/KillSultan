# 杀死苏丹 Online（MVP）

这是一个基于网页的多人实时身份推理游戏项目，核心玩法参考《杀死苏丹 / 推翻苏丹》。

## 文档入口

- 新手开局指南（简体中文）：[docs/quickstart-zh.md](docs/quickstart-zh.md)
- 玩家规则手册（Markdown）：[docs/玩家规则手册.md](docs/玩家规则手册.md)
- 玩家规则手册（DOCX）：[docs/玩家规则手册.docx](docs/玩家规则手册.docx)
- 角色图标命名规范：[apps/client/public/assets/roles/命名规范.txt](apps/client/public/assets/roles/命名规范.txt)

## 技术栈

- 服务端：Node.js + TypeScript + Socket.io + Redis（可选）
- 客户端：React + TypeScript + Socket.io Client + Vite
- 协议共享：`packages/shared`

## 快速启动

1. 安装依赖

```bash
npm install
```

2. 启动开发环境

```bash
npm run dev
```

3. 打开页面

```text
http://localhost:5173
```

服务端默认地址：

```text
http://localhost:3000
```

## 常用命令

- `npm run dev`：启动全部开发进程
- `npm run typecheck`：检查所有工作区类型
- `npm run rulebook:docx`：从 Markdown 生成 DOCX 规则手册
- `npm --workspace @sultan/server run build`：仅构建服务端
- `npm --workspace @sultan/client run typecheck`：仅检查客户端类型

## 已实现内容（当前口径）

- 房间系统：创建 / 加入 / 离开 / 准备 / 开始
- 回合动作：偷看 / 交换 / 换中间牌 / 公开
- 角色技能：苏丹、刺客、守卫、奴隶、占卜师、肚皮舞娘、奴隶贩子、大官
- 中立角色：4 张（占卜师、肚皮舞娘、奴隶贩子、大官）
- 断线重连：基于 token 的 `state:resync`
- 服务端权威判定：胜负和技能效果由服务端统一结算
- 信息隔离：暗牌不会广播给无权限客户端
- 规则弹窗：网站内可随时点击“查看规则”

## Redis（可选）

默认使用内存存储；如需 Redis 快照，配置：

```bash
REDIS_URL=redis://localhost:6379
```

## 项目结构

```text
apps/
  server/   # 服务端（权威状态机 + Socket.io）
  client/   # 前端（React 页面）
packages/
  shared/   # 前后端共享类型、规则与协议
docs/
  quickstart-zh.md
  玩家规则手册.md
  玩家规则手册.docx
```
