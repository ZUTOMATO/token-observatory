# Token Observatory

统计本机 **dsh / codex / claude code** 三个编码助手 token 用量的本地仪表盘。

## 运行

```bash
bash start.sh          # 默认 http://127.0.0.1:3180
PORT=4000 bash start.sh
```

浏览器打开 http://127.0.0.1:3180

## 功能

- **KPI**：累计 tokens、估算费用、今日、近 7 天（含环比）、缓存命中率
- **每日趋势**：三工具堆叠柱 + 7 日均线，14d/30d/90d/全部
- **模型排行**：按总量排序，附每个模型的估算费用
- **活跃时段热力图**：7×24（周一~周日 × 小时），可按工具切换
- **会话排行**：Top 会话（日期/工具/模型/调用次数/tokens/费用/首条消息），点击行展开完整首条消息、日期区间、工作区、文件路径；支持工具 + 时间范围筛选
- **分工具构成表**：Input / Cache Read / Cache Write / Output / 费用 / 构成条
- **单价设置**：页面右上角，按模型编辑 USD/1M tokens 单价，保存到 `prices.json` 并立即重算

## 数据源

| 工具 | 路径 | 解析内容 |
|---|---|---|
| dsh | `~/.dsh/sessions/<workspace>/session-<id>/session.jsonl.zstd` | `assistant/chunk` 的 usage；模型取自随后的 `assistant/message.source.model`；多帧 zstd 用 `zstd -dc` 解压 |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl` | `token_count` 事件的 `last_token_usage` 逐轮增量；input 中含的 cached 部分拆到 Cache Read |
| claude | `~/.claude/projects/<project>/<session>.jsonl` | assistant 消息的 `usage`，按消息 id **全局去重**（resume 会复制历史消息） |

## 说明

- 首次启动全量扫描（约 20s），之后每 60s 增量扫描：按 mtime/size 缓存，只重解变化的文件（`.scan-cache.json`，schema v3）。
- 页面每 30s 自动拉取 `/api/stats`；「重扫」按钮触发 `/api/rescan`。
- 日期与时段按本机时区分桶。
- 费用为估算：默认单价表是公开参考价（`server.js` 的 `DEFAULT_PRICES`，支持 `deepseek*` 式通配），你的渠道价格不同就在「单价设置」里改，覆盖值存 `prices.json`。
- 零依赖：Node ≥ 22.15，Chart.js 已本地化到 `public/vendor/`（Chart.js 为 MIT 许可）。
