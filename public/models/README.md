# 角色模型

把琪叶桃的 VRM 模型放在这里，文件名 `qiyetao.vrm`（也可以用环境变量 `NEXT_PUBLIC_VRM_URL` 指定别的地址，改了要重新构建）。

- 用 VRoid Studio 导出 VRM 0.x 或 1.0 都可以；需要有「aa」口型、「blink」眨眼和「surprised」惊讶表情（VRoid 默认就有）。
- 仓库里的 `qiyetao.vrm` 是 7.8 MB 的压缩版：用 `scripts/shrink-vrm.py` 从 VRoid 导出的 19.3 MB 版本压出来（表情变形只留 VRM 表情绑定的 14 个，2048 的贴图缩到 1024，缩略图缩到 512；网格、骨骼、材质不变，ADR-023）。换了新导出版也照这样压一遍再提交，大文件进了 Git 历史就删不掉。
- 放进来以后要重新 `npm run build`（生产模式只提供构建时就在 public 里的文件）。
- 没有这个文件时，工作台自动换成平面示意形象，并在形象下方写明原因。
- 模型是本队原创作品；公开仓库前确认模型和贴图的授权都写进 docs/PROVENANCE.md。
