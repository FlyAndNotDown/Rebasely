![Rebasely — Git + Perforce](site/public/assets/hero.svg)

<p align="center">
  <strong>连接 Git 与 Perforce，看清每一次变更。</strong><br><br>
  <a href="https://flyandnotdown.github.io/Rebasely/zh-CN/">官网</a> ·
  <a href="https://github.com/FlyAndNotDown/Rebasely/releases/latest">下载</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a> ·
  <a href="README.md">English</a>
</p>

Rebasely 是面向 **Git 与 Perforce** 的开源桌面客户端，使用 React、TypeScript、
Tauri 和 Rust 构建。在专注的工作区中审阅细节、理解历史，准备下一次变更。

## 清晰掌握你的工作

- **精确审阅。** 查看统一或并排文本差异、比较图片，在 Git 中按文件、差异块或单行暂存。
- **理解上下文。** 探索 Git 提交图、分支和文件历史，审阅 Perforce 变更列表与文件修订。
- **接续项目思路。** 通过标签页切换仓库，用命令面板和熟悉的快捷键找到操作，支持浅色和深色主题。
- **沿用现有工具。** 仓库操作通过 Git 与 Perforce CLI 执行，保留它们的配置及命令行行为。

| Git | Perforce |
| --- | --- |
| 打开、克隆或初始化仓库 | 连接或创建工作区 |
| 暂存、提交和查看历史 | 整理待提交变更列表，审阅修订 |
| 使用分支、Stash 和工作树 | 同步、核对、搁置和提交 |
| 审阅子模块与 Git LFS 工作流 | 浏览工作区与仓库文件 |
| 重命名分支、设置上游和编辑远端地址 | 重命名或移动文件、锁定提交和撤销修订 |
| 合并、变基和挑选提交 | 在经典工作区中预览单文件集成 |

试试[互动 Git 与 Perforce 演示](https://flyandnotdown.github.io/Rebasely/zh-CN/#features)。
演示使用虚构数据，不会修改真实仓库。

## 开始使用

1. 下载适用于 **macOS Apple Silicon** 或 **Windows x64** 的
   [最新版本](https://github.com/FlyAndNotDown/Rebasely/releases/latest)。
2. 为 Git 仓库安装 **Git**，为 Perforce 工作区安装 **Perforce CLI（`p4`）**。
   如有需要，在设置中选择对应的可执行文件。
3. 打开本地文件夹、克隆 Git 仓库，或连接 Perforce。

应用支持英语和简体中文，默认跟随系统语言，也可在设置中手动选择。
官网优先使用浏览器语言，并提供语言切换入口。没有匹配的语言时使用英语。

本地文件保留在你的设备上。远程操作连接你配置的服务器。
诊断信息存储在本地，不会自动上传。

## 从源码构建

准备 Node.js 22.13+（22.x）、24.x 或 26+，稳定版 Rust，以及
[Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。
在 Linux 上构建时，还需要安装对应的 Linux 平台依赖。

```sh
npm ci
npm run dev
```

构建应用安装包：

```sh
npm run build
```

项目结构与检查命令见[开发指南](docs/development.md)。
参与贡献请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；
处理代码的代理还应阅读 [AGENTS.md](AGENTS.md)。代码、注释和开发文档使用英文，
翻译文本集中存放在语言资源文件中。

## 反馈与安全

欢迎在 [Issues](https://github.com/FlyAndNotDown/Rebasely/issues) 报告可复现的问题或提出建议。
分享附件前，请移除凭据、私有主机、仓库详情和本地路径。
报告漏洞请遵循[安全政策](SECURITY.md)。

## 许可证

[MIT](LICENSE)
