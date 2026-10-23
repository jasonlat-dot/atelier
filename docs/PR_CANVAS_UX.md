# 画布交互修订

负责人反馈：拖动、连接、文字编辑与操作入口不顺畅，要求参考 infinite-canvas 并继续完善截图中的细节。

## 参考审计

参考 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas/tree/9f2bd9f1b27c45fd1b8f5323072b07243f9e0fac)。已读取 web/src/components/canvas 下的 infinite-canvas、canvas-toolbar、canvas-node-hover-toolbar、canvas-zoom-controls、canvas-connections、canvas-context-menu，以及 canvas-shortcuts/canvas-node-manual 中文手册。用独立 Chrome 上下文查看公开演示，不读取用户浏览器资料、不登录或提交付费请求。

参考的核心是：空白区域用于移动视口；文字双击编辑；节点工具栏就近显示；连接线有宽命中区域；拖线创建带来源；底部图标提供明确提示；参数按需展开。按当前服务能力独立实现，不复制其代码；音频、AI 文本生成与推理设置不在当前接口能力内。

## 切片 1：手势与保存

- 解决每帧全图序列化、拖动产生多个历史项与保存过程中继续拖动可能重复保存中间状态的问题。
- editorStore 的 preview 只处理受限几何更新；end 创建一个可撤销操作，并清空旧重做分支。ProjectSaver 在手势期间等待，flush 先结束手势。
- tests/canvas-state.test.cjs 共 4 项，覆盖 500 节点/200 帧不序列化、连线规则、手势内 flush、旧保存响应与新手势并发。CI 已加入此回归。
- 本地 4/4、前端 typecheck/lint/mock 通过；远端结果待提交后记录。

## 切片 2：界面与交互（进行中）

底部工具栏、悬停提示、节点工具栏、拖线创建菜单、曲线选取/删除、局部参数面板、快捷键、空间与多选、图层查找、模型能力错误提示。完成后补充完整浏览器与真实 PG/Redis 验收，不声明未验证内容可用。

S3 与视频尾帧协议扩展仍待定。本轮不改变积分、权限、上游地址支持或数据库契约，不自动进入 M8。
