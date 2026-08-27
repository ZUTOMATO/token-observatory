# 在创造模式会话里激活 Token Observatory 插件

把下面整段粘贴进一个**创造模式**新会话即可。

---

请加载 cordis-plugin-development skill，然后为我把一个现成的双半插件定义并运行起来：

1. 读取两个文件：
   - `/home/zutomato/token-dashboard/cordis-plugin/host.js` —— host 半：插件激活时检查本地仪表盘服务 `http://127.0.0.1:3180` 是否在跑，没跑就自动拉起（`node /home/zutomato/token-dashboard/server.js`）；暴露 `tok-obs-status` 方法供 client 轮询；插件停止时杀掉它拉起的子进程。**不用开机自启，不用手动跑 sh，服务随 dsh 进程生灭。**
   - `/home/zutomato/token-dashboard/cordis-plugin/client.js` —— client 半：侧栏 `sidebar.footer.action` 注册入口按钮，`shell.overlay` 注册全屏 overlay，轮询 host 确认服务就绪后 iframe 嵌入仪表盘。
2. 按 skill 流程先用 inspect 核对真实接口，**只做必要的最小调整**：
   - host 半：`subprocess` / `bash` / `web` 三个 Service 的真实方法名与参数形状（spawn 和 fetch 的写法可能与我注释里的占位不同），以及 `harness` Builtin；
   - client 半：`sidebar.footer.action` 与 `shell.overlay` 两个 Slot 的注册协议（kind/scope/选项/props/占用者）。
   业务逻辑（生命周期、轮询、overlay、iframe、样式）保持不变；若某个 Slot 不存在，改用 inspect 结果里最接近的附加型入口，不要替换整块产品 UI。
3. `cordis_define`：label `Token Observatory`，purpose `在 dsh GUI 内打开本地 token 用量仪表盘（dsh/codex/claude）`，提交 host 半与 client 半。
4. `cordis_run` 激活；需要授权就等我点确认。加载/渲染/启动失败就用 `cordis_inspect_self` 读诊断，定义新 Package 修复，不要覆盖旧 Package。
5. 完成后告诉我：插件 id、当前状态、侧栏入口位置，以及 `http://127.0.0.1:3180` 是否已被插件自动拉起。

说明：插件是进程级的，dsh 重启后需要重新 run；服务生命周期完全由插件管理（停插件即停服务），不涉及任何开机自启动配置。