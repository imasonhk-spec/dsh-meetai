# dsh-meetai

DSH 会议助手：会议日程与 AI 议程、模板纪要生成与签署归档、可溯源会议问答（主内容区应用）。源码 = 8.6 宿主 live 副本快照（2026-09-28，`~/01-DSH/06-会议助手/dsh-meetai`，经 node_modules 符号链接热载）。部署：宿主 profile + admin 账号（两份副本 tar 聚合 md5 一致）。

## 结构

- `client.js` — 面板 + 主内容区应用（前端）
- `index.js` — 服务端注册入口
- `scripts/` — 冒烟/结构检查/分片上传契约脚本

## 发行件

`dist/dsh-meetai-0.2.7-rc.1.tgz` —— 确定性构建（校验见 [CHECKSUMS.md](dist/CHECKSUMS.md)）。

## 版本

| 版本 | 内容 |
| --- | --- |
| 0.2.7-rc.1 | 首发 = 8.6 线上活副本快照（2026-09-28） |
