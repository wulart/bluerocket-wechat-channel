# BlueRocket WeChat Channel

[中文文档](README_zh.md)

WeChat channel plugin for [BlueRocket](https://www.loopupai.com/desktop), a desktop AI app empowering teens to learn and build anything. This plugin bridges WeChat messages to the BlueRocket AI coding agent, allowing users to interact with BlueRocket directly through WeChat.

## Features

- WeChat QR code login with credential persistence
- Automatic message polling and reply
- Per-conversation session management (DMs and groups)
- Long message auto-splitting for WeChat limits
- Markdown stripping for plain-text WeChat replies
- Typing indicator keepalive while processing

## Prerequisites

- [BlueRocket](https://www.loopupai.com/desktop) desktop app installed and running
- Node.js >= 18 (or [Bun](https://bun.sh/))
- A WeChat account with ilink bot access

## Quick Start

### 1. Install BlueRocket

Download and install from [loopupai.com/desktop](https://www.loopupai.com/desktop), then launch the app.

### 2. Build

```bash
git clone https://github.com/wulart/bluerocket-wechat-channel.git
cd bluerocket-wechat-channel
npm install
npm run build
```

### 3. Setup WeChat login

```bash
npx bluerocket-wechat-channel setup
```

Scan the QR code with WeChat to authenticate. Credentials are saved locally for subsequent runs.

### 4. Start the channel

```bash
npx bluerocket-wechat-channel start
```

The channel will connect to the BlueRocket server and start listening for WeChat messages.

## License

[MIT](LICENSE)
