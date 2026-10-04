# 参与贡献

欢迎通过 [GitHub Issues](https://github.com/wobuyaoquminga/diandian-counter/issues) 报告问题或提出建议。请写明使用的是浏览器版还是 Android 版、版本、复现步骤和实际结果；涉及本地数据时请先自行留存备份，不要公开包含私人记录的 JSON。

提交修改前，请先查看现有 Issue，尽量让每次改动聚焦一个问题。网页入口是根目录 `index.html`，逻辑在 `app.js`、`store.js` 和 `persistence.js`；Android 构建说明见 [android/README.md](android/README.md)。

改动计数或历史逻辑后，在项目根目录运行 `node --test store.test.js`。涉及界面、浏览器存储或导出时，请再运行 `node tests/browser-check.cjs`（需要 Playwright 和 Chromium），并在提交说明中写明测试结果。发布 APK 前还应完成真机安装和导出检查。

参与本项目即同意按照仓库的 [AGPL-3.0-only 许可证](LICENSE) 提交贡献。
