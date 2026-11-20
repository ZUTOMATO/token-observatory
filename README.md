# Token Observatory

统计本机 **dsh / codex / claude code** 三个编码助手 token 用量的本地仪表盘。

## 运行

```bash
bash start.sh          # 默认 http://127.0.0.1:3180
PORT=4000 bash start.sh
```

浏览器打开 http://127.0.0.1:3180

## 复盘近 7 天

点击首页的「近 7 天」即可查看增长最多的三个项目，再点项目名查看净输入、输出、缓存读取和缓存写入的变化，以及各模型、各会话的两期用量。展开会话可查看主机、日期区间、日志路径和精确计数。「查看全部」也会列出持平和下降的项目。

本期从本机日期的六天前到今天，上期是再往前连续七天。无活动日期计为零，跨周会话按实际发生用量的日期拆分。切换顶栏主机时，周环比、项目和周报会一起切换。

在该面板点击「编写周报」，勾选代表会话，按需读取项目当前 Git 分支在本期的提交，填写工作结果后导出 Markdown。导出内容包含所选主机的本期总用量、估算费用和手工选入的事项。每个项目最多展示最近 100 条提交。

## 汇总多台设备

1. 在每台电脑上打开「设备汇总」。可以在「本机名称与导出别名」里取一个便于识别的设备名称，为同一个项目填写相同别名。
2. 点击「导出本机摘要」。JSON 仅含格式版本、设备标识与显示名称、导出时间、当地日期、项目别名和四类 token 数。默认项目别名是该设备专用的匿名代号。
3. 在汇总电脑上点击「导入其他设备摘要」。本机与导入设备的累计用量、近七天用量和变化会按设备及项目别名展示。相同设备的新版完整摘要替换旧版，重复导入只计一次。导出始终只取本机的 Linux / Windows 日志。

设备标识、别名和导入记录保存在数据目录的 `.observatory-devices/`。更新程序时保留该目录可延续同一设备身份。每份导入文件上限 16 MiB，设备摘要采用手动交换。原始会话和 Git 周报留在各自的设备上。

## 功能

- **KPI**：累计 tokens、估算费用、今日、近 7 天（含环比）、缓存命中率
- **主机维度**：顶栏「主机」切换（全部 / Linux / Windows），全局作用于 KPI、总量构成、趋势、模型、项目、工作日志、热力图与会话
- **每日趋势**：三工具堆叠柱 + 7 日均线，14d/30d/90d/全部
- **模型排行**：按总量排序，附每个模型的估算费用
- **项目视图**：按 Git 根目录归并不同工具、子目录与 `.worktrees/*` 会话，点击查看模型与最近会话
- **AI 工作日志**：按日期回顾参与的项目、工具、token 用量与代表任务
- **活跃时段热力图**：7×24（周一~周日 × 小时），可按工具切换
- **会话排行**：会话（日期/工具/项目/模型/调用次数/tokens/费用/首条消息），点击行展开完整首条消息、日期区间、工作区、文件路径；支持跨全部会话搜索、工具 + 时间范围筛选
- **分工具构成表**：Input / Cache Read / Cache Write / Output / 费用 / 构成条
- **单价设置**支持按模型编辑 USD/1M tokens 单价，选择生效日期后按用量发生日重算。已有 `prices.json` 里的 `perM` 会作为历史基准价保留，同一天修改一个模型会保留其他模型的单价。

批量更新当前价格可以运行 `node update-prices.js`。使用 `--effective-date YYYY-MM-DD` 指定生效日，`--dry-run` 预览变更，`--official ./official-prices.json` 指定离线价格表。

## 数据源

| 工具 | 路径 | 解析内容 |
|---|---|---|
| dsh | `~/.dsh/sessions/<workspace>/session-<id>/session.jsonl.zstd` | `assistant/chunk` 的 usage；模型取自随后的 `assistant/message.source.model`；多帧 zstd 用 `zstd -dc` 解压 |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl` | `token_count` 事件的 `last_token_usage` 逐轮增量；input 中含的 cached 部分拆到 Cache Read |
| claude | `~/.claude/projects/<project>/<session>.jsonl` | assistant 消息的 `usage`，按消息 id **全局去重**（resume 会复制历史消息） |

**Windows 主机（WSL 自动发现）**：启动时自动扫描 `/mnt/c/Users/*/` 下存在 `.codex` / `.claude` 的用户目录，同一解析器并入统计；会话表以 `·win` 徽标区分，展开行显示主机。首次扫描会读取 Windows 侧全部历史（可能数 GB，约 1~2 分钟），之后仅增量。

## 说明

- 首次启动全量扫描（约 20s），之后每 60s 增量扫描：按 mtime/size 缓存，只重解变化的文件（`.scan-cache.json`，schema v4）。
- 页面每 30s 自动拉取 `/api/stats`；「重扫」按钮触发 `/api/rescan`。
- 日期与时段按本机时区分桶。
- 费用为估算值，默认采用 `lib/prices.js` 的参考价，支持 `deepseek*` 式通配。渠道单价和按日期生效的变更存入 `prices.json`。
- 零依赖：Node ≥ 22.15，Chart.js 已本地化到 `public/vendor/`（Chart.js 为 MIT 许可）。
- 可用 `OBS_DATA_DIR` 单独指定统计缓存、价格与设备数据目录，默认使用项目目录。`OBS_LOG_HOME` 与 `OBS_WINDOWS_USERS_DIR` 可分别指定本机日志所在的用户目录和 Windows 用户目录。
- 在仓库根目录执行 `node --test` 即可运行回归测试。测试使用临时日志、临时 Git 仓库和独立的数据目录。
