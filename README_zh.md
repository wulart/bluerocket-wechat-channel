# BlueRocket 微信通道

[English](README.md)

BlueRocket 微信通道插件。BlueRocket 是一款面向青少年的桌面 AI 应用，支持学习和构建任何东西。本插件将微信消息桥接到 BlueRocket AI 编程助手，让用户可以通过微信直接与 BlueRocket 交互。

## 功能特性

- 微信扫码登录，凭据本地持久化
- 自动轮询消息并回复
- 按会话管理（私聊和群聊）
- 长消息自动分段，适配微信字数限制
- 自动去除 Markdown 格式，以纯文本回复
- 处理期间发送"正在输入"状态

## 前提条件

- 已安装并运行 [BlueRocket](https://www.loopupai.com/desktop) 桌面应用
- Node.js >= 18（或 [Bun](https://bun.sh/)）
- 拥有 ilink 机器人权限的微信账号

## 快速开始

### 1. 安装 BlueRocket

从 [loopupai.com/desktop](https://www.loopupai.com/desktop) 下载安装并启动。

### 2. 构建

```bash
git clone https://github.com/wulart/bluerocket-wechat-channel.git
cd bluerocket-wechat-channel
npm install
npm run build
```

### 3. 微信登录

```bash
npx bluerocket-wechat-channel setup
```

使用微信扫描二维码完成认证。凭据会保存在本地，后续无需重复登录。

### 4. 启动通道

```bash
npx bluerocket-wechat-channel start
```

通道将连接到 BlueRocket 服务器，并开始监听微信消息。

## 许可证

[MIT](LICENSE)
