# HalloChat（ImGui + C++ 客户端 / Node.js 服务端）

- **客户端**：C++ + **Dear ImGui** + GLFW + OpenGL（桌面 GUI）
- **服务端**：Node.js + Express + ws（WebSocket）
- **已实现功能**：注册/登录（HTTP）→ 取好友列表（HTTP）→ WebSocket 鉴权 → 群聊/私聊消息


---

## 项目开发者
### 墨染柒DarkSeven
- 邮箱：moranqidarkseven@hallochat.cn
- 个人博客：[墨染柒的个人博客-GitHub Pages（可能停止更新）](https://Ink-dark.github.io/)

### SANYOU （LUCA.NEX)
- 邮箱：sanyou1@hallochat.cn
- 个人网站:[lucanex.top](https://www.lucanex.top/)


## 目录结构

```
HalloChat-cpp-on-imgui/
├── 客户端/
│   └── cpp/                 # C++ ImGui 客户端（CMake）
│       ├── CMakeLists.txt
│       └── src/main.cpp
└── 服务端/
    ├── src/server.js        # Node.js 服务端（Express + ws）
    ├── Account/             # 账号/好友/私聊数据（运行后生成）
    ├── group_chat.json      # 群聊数据（运行后生成）
    ├── package.json
    └── monitor/             # 监控相关（可选）
```

---

## 功能概览

### 1) HTTP API

- `POST /api/auth/register`
  - body: `{ "username": "xxx", "password": "xxxxxx" }`
  - resp: `{ success, uid, username, token }`

- `POST /api/auth/login`
  - body: `{ "username": "xxx", "password": "xxxxxx" }`
  - resp: `{ success, uid, username, token }`

- `POST /api/friends/add`（需要 Bearer token）
  - header: `Authorization: Bearer <token>`
  - body: `{ "uid": "好友UID" }`

- `GET /api/friends/list`（需要 Bearer token）
  - header: `Authorization: Bearer <token>`

- 其他：`GET /health`、`GET /stats`、`GET /metrics`

### 2) WebSocket 协议

连接路径：`WS_PATH`（默认 `/ws`）

客户端 → 服务端：
- 鉴权：`{ "type": "auth", "token": "..." }`
- 群聊：`{ "type": "message", "text": "Hello" }`
- 私聊：`{ "type": "private", "toUid": "...", "text": "Hi" }`

服务端 → 客户端：
- 系统消息：`{ "type": "system", "message": "...", "ts": 1700000000000 }`
- 群聊消息：`{ "type": "message", "uid": "...", "name": "Alice", "text": "...", "ts": ... }`
- 私聊消息：`{ "type": "private", "fromUid": "...", "fromName": "...", "toUid": "...", "text": "...", "ts": ... }`

---

## 快速开始（macOS / Linux）

### 0) 准备环境

- Node.js（建议 18+）
- C++ 工具链（macOS 安装 Xcode Command Line Tools 后默认有 clang）
- CMake + Ninja（推荐）

macOS 一键装 CMake/Ninja：
```bash
brew install cmake ninja
```

---

## 1) 启动服务端

```bash
cd "服务端"
npm install
npm run dev
```

默认环境变量：
- `PORT`：默认 `3001`
- `WS_PATH`：默认 `/ws`
- `ALLOWED_ORIGIN`：默认 `http://localhost:5173`

服务端启动后：
- HTTP API：`http://localhost:3001/api/...`
- WebSocket：`ws://localhost:3001/ws`

> 数据存储：账号写入 `服务端/Account/<username>_<uid>/pak.JSON`；好友/私聊写入 `服务端/Account/<username>_<uid>/<friendUid>.json`；群聊写入 `服务端/group_chat.json`。

### 密码安全说明

服务端使用 **PBKDF2 + salt** 存储密码：
- `passwordSalt`：16 字节随机盐（hex）
- `passwordHash`：`pbkdf2(password, salt, 100000, 32, sha256)`

---

## 2) 构建并运行客户端（C++ ImGui）

客户端路径：`客户端/cpp`

### 首次构建（推荐 Ninja）

```bash
cd "客户端/cpp"
cmake -S . -B build -G Ninja -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build build -j 8
```

运行：
```bash
cd build
./hallochat-imgui
```

### 客户端使用方式

1) 在 UI 里填写服务端地址（默认：`http://localhost:3001`）
2) 在“注册/登录”页完成注册或登录（成功后拿到 token）
3) 客户端会自动连接 WebSocket `/ws`，并发送 `{type:"auth", token}` 完成鉴权
4) 点“刷新好友”拉取好友列表
5) 选择“大群”或某个好友 → 发送群聊/私聊消息

---

## 3) 启动监控网站（可选）

```bash
cd "服务端/monitor"
npm install
npm run dev
```

默认访问地址：
- 监控网页：`http://localhost:5173`
- 页面内默认服务端地址：`http://localhost:3001`

你可以在页面右上角修改服务端地址。

---

## macOS 专用注意事项（很关键）

### 1) OpenGL 版本

macOS 对 OpenGL 3.0/3.1 的支持不稳定，建议使用 **OpenGL 3.2 Core Profile**。

本仓库客户端已做了 macOS 修正：
- `GLFW_CONTEXT_VERSION_MAJOR=3`
- `GLFW_CONTEXT_VERSION_MINOR=2`
- `GLFW_OPENGL_CORE_PROFILE`
- `GLFW_OPENGL_FORWARD_COMPAT`
- `glsl_version = "#version 150"`

如果你看到类似报错：
> NSGL: macOS does not support OpenGL 3.0 or 3.1...

说明你需要升级为 3.2+ Core Profile（本项目已处理）。

### 2) 中文显示变成“????”

ImGui 默认字体不包含中文 glyph，会显示问号。

本仓库客户端已做了 macOS 中文字体加载：
- 优先 `Hiragino Sans GB.ttc`
- 失败 fallback `STHeiti Light.ttc`
- glyph range: `GetGlyphRangesChineseFull()`

---

## 常见问题（Troubleshooting）

### Q1：客户端窗口一闪就没了/终端显示 `Glfw Error ...`
- 优先看 OpenGL 版本是否是 3.2 Core
- 确认服务端是否在跑（客户端登录/好友接口需要 HTTP 可达）

### Q2：登录成功但 WS 一直 disconnected
- 确认服务端 `WS_PATH`（默认 `/ws`）
- 客户端里 `wsPath` 是否一致
- 确认 token 是否正确（WS 首包会发 auth）

### Q3：好友列表为空
- 先确保双方互加好友：`添加好友` 填对方 UID
- 再点 `刷新好友`


## License 许可证声明

本项目使用 **GNU LGPL v3（GNU Lesser General Public License, Version 3）**。

- 许可证全文：见仓库根目录 `LICENSE`

简要说明（非法律意见）：
- 你可以使用、修改、分发本项目，但分发时需要遵守 LGPL 的条款。
- 如果你修改了本项目（或把它作为库进行链接并发布），通常需要提供相应的源码/修改说明，并保留许可证与版权声明。
- 具体以 `LICENSE` 原文为准。
