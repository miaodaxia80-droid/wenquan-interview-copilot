# 问全 0.5.2 · 浅色手机 UI

依据用户提供的独立原型 `wenquan-ui-workspace/prototype/`，先在浏览器查看首页、准备、会中、会后，再应用到当前 0.5.2。原型中的演示入口没有恢复；五个模板与既有记录保留。

## 实现范围

仅修改 `web/index.html`、`web/style.css`、`web/interview-ui.js` 三个产品文件。

- 页面底 #F8FAF9，卡片底 #FFFFFF，翠绿主色 #10B981，hover #059669；18px 卡片圆角、胶囊按钮和双层阴影。
- 三项底栏“访谈 / 记录 / 设置”。记录沿用当前会后回看，设置打开既有分析设置弹窗；会中用 CSS 根据实际视图隐藏底栏，未增加视图状态逻辑。
- 准备页保留全部字段、data-field、data-item、name 与验证提示；展示主线序号、必聊标签及预设问题预览。文本演练与录音使用原有动作及表单提交。
- 会中使用绿色描边与辉光的当前问题卡，18px/500 主问句；完整问题、原话依据和略过放入折叠区。候选带选中圆圈；最近五段转写区分双方角色。底部暂停、稍后、已问、结束沿用既有 data-action；无候选、暂停和结束状态按已有状态禁用。
- 采集计时复用 capture-time 元素及原有更新逻辑，无原型模拟时钟。
- 会后保留整场归纳、全部原话出处及来源定位、人工摘要、补问、历史记录和两种导出。摘要编辑放入原生 details，保存仍走原有动作。
- 所有 details 使用直接子 summary 的 ▸ 箭头，只有自身展开才旋转，避免嵌套折叠箭头误旋转。
- 未改 app.js、interview.js、intelligence.js、manifest、网络层或眼镜实现；原有 reviews / interviewSummary 相关修复继续保留。

## 实际验证

- `npm run check` 通过。
- `npm test` 108/108 通过，既有测试未删除、未修改。
- `npm run build` 成功，重新生成 dist、MMPKG 和 SDK 工作区镜像。
- `git diff --check` 通过。
- 浏览器实际布局宽度约 291、354、818 CSS px 均无横向溢出，五个模板仍可用。
- 页面 computed background 为 rgb(248,250,249)，当前问题描边 rgb(16,185,129)，辉光 rgba(16,185,129,.15) 0 4px 24px，主问句 18px。
- 在隔离的本地预览来源添加明确标注为虚构的 UI 测试记录，使用现有核心/校验函数准备候选及摘要，没有调用模型、没有使用麦克风，也没有修改 Studio 中的用户数据。
- 点击候选后当前问句与选中状态一致；暂停禁用稍后和已问；继续仍是文本演练；稍后与已问实际更新为 deferred / asked，无当前候选后回到聆听状态。
- 展开原话可看到真实测试片段及“无音频时间”来源；人工修改摘要保存成功，实际下载的素材索引和完整 Markdown 都包含该修改。
- 设置底栏成功打开既有弹窗。

浏览器截图与导出位于 evidence/light-ui-*，完整测试结果为 evidence/test-results-light-ui.txt。

## 安装包

- `release/wenquan-0.5.2.mmpkg`：本次浅色界面构建。
- `release/问全-0.5.2-Studio.zip`：Studio 导出的新组合包。
- 改造前的同版本包保留在 `release/before-light-ui/`。

Studio 实际导出文件 `wenquan-0.5.2-05d3eb0dbd1c.zip`；组合包 SHA-256：7eaa7ef7db8e372196db7b91adc9eedc217970c957a6850979b01b6516b1f16f。

MMPKG 与 GMP 的配对元数据通过；组合 ZIP 中组件字节及 review 哈希与本次构建一致，见 evidence/Studio-bundle-light-ui.json。现有 review v3 与官方 v1/v2 校验器的兼容限制仍存在，此核对不代表签名或审核批准。

Studio 刷新后手机预览出现 about:blank；重新启动后显示登录页，本轮未完成浅色 UI 的原生运行验收，也未进行登录操作。组合包在重启前已成功导出并核对；后续可登录 Studio 后导入该包继续扫码验证。

版本维持 0.5.2，未修改 manifest/权限。个人连接配置安装包仅本地交付，不上传 GitHub。手机扫码安装、真实眼镜佩戴和手机软键盘效果未验证；本轮没有服务端部署。
