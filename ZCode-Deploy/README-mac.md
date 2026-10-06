# ZCode-Deploy macOS 版

把 Windows 版部署工具完整移植到 macOS。六补丁逻辑与 `deploy.ps1` 完全同源，
锚点仍是语义字面量 + 花括号配平，不依赖压缩变量名。

## 安装前提

- macOS（Apple Silicon / Intel 均可）
- [Node.js](https://nodejs.org)（`brew install node`）—— 语法校验与功能验证必需
- ZCode.app 装在 `/Applications`（或 `~/Applications`；其它位置用 `ZCODE_DIR` 指定）

## 使用

Finder 双击（等价于 Windows 的 .bat）：

```
部署.command        一键部署
恢复.command        恢复原版
查看状态.command    查状态
验证.command        诊断 + 功能验证
```

命令行方式（等价于 Windows 的 `deploy.ps1`）：

```bash
./deploy.sh install          # 部署（备份原版 -> 六补丁 -> node --check -> 重启 ZCode）
./deploy.sh restore          # 还原原版（保留人格文件）
./deploy.sh status           # 查看部署状态与补丁校验
./deploy.sh diag             # 注入点诊断（列出全部注入片段及其产物函数）
./deploy.sh help

./deploy.sh install --no-restart      # 部署后不重启 ZCode
./deploy.sh install --allow-partial   # 有补丁未命中也强行部署（默认中止）
ZCODE_DIR=/path/to/ZCode.app ./deploy.sh status   # 手动指定安装目录
```

## 换人格

直接编辑 `人格.txt`，保存，开新对话生效。不需要重启，不需要重跑部署。

## 安装目录检测（macOS 顺序）

1. 环境变量 `ZCODE_DIR`（指到 `ZCode.app` 这一层）
2. 运行中的 ZCode 进程路径（`ps` 扫描 `ZCode.app/Contents/MacOS/`）
3. 缓存 `zcode-dir.txt`（上次检测结果）
4. `/Applications/ZCode.app`、`~/Applications/ZCode.app`
5. 两个应用目录的一层扫描

目标文件：`<ZCode.app>/Contents/Resources/glm/zcode.cjs`

## 验证

```
验证.command
```

两步：`deploy.sh diag`（列出 10 个注入片段）+ `verify-patch.cjs`（**真正执行**
补丁后的函数，确认读取表达式读得到人格文件、日期/Skills/UserContext 返回 null、
CLI Prefix 内容为空、Agent Identity 内容等于人格全文）。

mac 版 verify-patch 已修复 Windows 版的一个隐患：不再硬编码旧 bundle 的
压缩变量名（`FVs`），改为动态扫描补丁后函数的自由变量 —— ZCode 更新改名后验证器依然可用。

模型请求日志（mac 同路径）：

```
~/.zcode/cli/rollout/model-io-*.jsonl
```

system 层应为 `人格.txt` 全文，且不含 `You are ZCode`、安全策略、日期提醒。

## macOS 特有说明

| 事项 | 说明 |
|------|------|
| 生效条件 | `zcode.cjs` 在进程启动时加载——**已运行的 ZCode 不会热加载补丁**，必须完全退出（⌘Q，不是关窗口）再重开才生效 |
| 重启方式 | `osascript` 优雅退出 ZCode，退不掉再 `pkill`；随后 `open ZCode.app`。⚠️ 如果你的 AI 会话正跑在 ZCode 里，不带 `--no-restart` 跑 install 会把会话一起杀掉 |
| 进程检测 | Electron 主进程在 ps 里显示为 `ZCode`、Helper 在 `Contents/Frameworks` 下，检测同时匹配 `MacOS` 与 `Frameworks`（v2.1.0-mac 已修） |
| 代码签名 | 本工具只改 Resources 里的 `zcode.cjs`（非可执行文件），正常不影响启动。万一改完 ZCode 打不开，执行 `codesign --force --sign - /Applications/ZCode.app` 重签即可 |
| 双击被拦 | Gatekeeper 拦截 quarantined 脚本时：右键 `部署.command` → 打开；或 `xattr -cr .` |
| 权限 | `zcode.cjs` 属主是当前用户（App 安装到自己目录时），无需 sudo；若装在别处属主是 root，`install` 前先 `sudo chown -R "$USER" /Applications/ZCode.app` 或用 sudo 跑 |
| 中文文件名 | 解压发行 zip 请用系统解压 / `unzip` / The Unarchiver，不要用会转码的工具 |

## 文件说明

```
部署.command / 恢复.command / 查看状态.command / 验证.command   Finder 双击入口
deploy.sh           命令行入口（薄封装）
deploy.cjs          主引擎（install / restore / status / diag，全部逻辑在这）
verify-patch.cjs    功能验证器（真正执行补丁后的函数）
build-release.sh    发布打包（白名单 + MANIFEST + SHA256）
人格.txt            人格文件（唯一编辑入口）
backups/            原版归档（保留 6 份）
zcode-dir.txt       安装目录缓存
deploy.ps1 等       Windows 版脚本（保留，跨平台双栈）
```

## 与 Windows 版的差异

- 引擎从 PowerShell 移植为 Node（`deploy.cjs`），逻辑逐条对齐：六补丁、失败即中止、
  语法门禁、备份轮转、原子写入（temp + rename，保留文件权限）
- 路径检测与重启适配 macOS（见上）
- `verify-patch.cjs` 动态自由变量解析（Windows 版硬编码 `FVs`，换 bundle 即失效）
- 打包脚本 `build-release.sh` 等价移植，白名单分必需/可选

## 免责声明

本工具仅用于修改本地安装的软件配置。请遵守 ZCode 服务条款，自行承担使用风险。
