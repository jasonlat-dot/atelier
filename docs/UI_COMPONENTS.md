# 共享 UI 组件

## 悬停反馈约定

按钮悬停保持原有深浅层级、文字对比和尺寸，使用清晰可感知的中等幅度背景/边框变化，避免深色按钮跳成浅色、位移或缩放。全局提供 `--control-hover-ink`（#36373e）、`--control-hover-surface`（#eeece6）和 `--control-hover-duration`（140ms，减少动态效果时为 0）；新按钮沿用这些值，特殊的危险操作仍保留语义色。禁用控件不应用悬停变化，键盘 focus-visible 保持清晰。

容器级通用 hover 必须低于主按钮和选中态优先级，使用 `:where(:hover:not(:disabled))` 或明确限定未选中控件。不能用一个高优先级的 `button:hover` 覆盖容器下所有按钮；嵌入 Select/DatePicker 等共享组件时，页面规则只控制布局，不接管其悬停外观。

## Tooltip · 悬停与焦点说明

统一实现为 `apps/web/src/components/Tooltip.tsx`、Tooltip.css 与 tooltipPosition.ts，设计参考 `public/ui-register/tooltip-component/`。`main.tsx` 只挂载一次 TooltipHost，正式应用和 Mock 共用；不在页面中重复挂载宿主或创建独立提示浮层。

新代码优先使用 React 组件：

```tsx
import Tooltip from '../../components/Tooltip';

<Tooltip content="刷新最新数据">
  <button aria-label="刷新数据">…</button>
</Tooltip>

<Tooltip title="任务成功率" content="成功含部分完成，不计取消及进行中的任务。">
  <span className="tooltip-hint">任务成功率</span>
</Tooltip>

<Tooltip content="不能禁用超级管理员账号">
  <button disabled>禁用账号</button>
</Tooltip>
```

参数为纯文本 `content`、可选标题 `title`、`placement="top|bottom"`（默认 top）、`delay`（默认 300ms）和单个 children。空说明不创建提示。普通触发元素沿用原 DOM、事件和 ref；禁用控件由组件包一层可聚焦的 span 接收悬停与键盘事件，保留原控件的 disabled 行为。需要保留父级 flex 对齐等布局时，将相应布局类放入 `wrapperClassName`。

原生元素与透传 DOM 属性的图表/画布适配同样复用宿主：

```tsx
<strong tabIndex={0} data-tip={fullName}>{shortName}</strong>
<div tabIndex={0} data-tip="说明" data-tip-title="标题"
  data-tip-placement="bottom" data-tip-delay={300}>…</div>
```

静态文字触发器应可键盘聚焦。禁用按钮必须使用 Tooltip 包装，不能只把 data-tip 写在 disabled 元素上。不要新增原生 HTML title 悬停提示、页面自制 role=tooltip 节点或 CSS 伪元素气泡；AdminDialog/页面组件的 title 是实际标题，保留其内容语义。

全局同一时刻仅一个提示，悬停或聚焦 300ms 后展示；移出、失焦、点击、滚动、缩放、窗口失焦、来源卸载或隐藏后关闭，Esc 优先关闭当前提示。说明不抢焦点，保留已有 aria-describedby；原生弹窗内使用同一提示层，支持 top/bottom 翻转、8px 视口夹紧、箭头定位和减少动态效果偏好。触摸 hover:none 不展示，关键信息仍需在页面直接可见。

视觉为深墨底、白字、10px 圆角、280px 最大宽与箭头，纯文本不可交互。复制、参数填入等轻量反馈使用下文共享 Toast；积分、删除、安全变更、业务错误及确认仍使用 Feedback 遮罩弹窗。可交互内容使用已有菜单或弹窗组件。

`npm run test:mock` 包含 Tooltip 源码约束与定位回归，防止原生提示、多个宿主或局部提示重新出现。

## Select · 全局单选下拉

实现为 `apps/web/src/components/Select.tsx`、Select.css 和 selectBehavior.ts，参考 `public/ui-register/compoment/select-component/`，无需第三方依赖。正式页与 Mock 页统一使用，不直接写原生下拉或另建 listbox；内部唯一的隐藏原生字段只负责表单数据、原有 change 回调和必填验证，不进入焦点顺序或辅助技术树。

新代码推荐使用 options 和 onValueChange：

```tsx
import Select from '../../components/Select';

<Select
  aria-label="质量"
  value={quality}
  onValueChange={setQuality}
  options={[
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
  ]}
/>
```

- `options` 项为 value、label、可选 description、group 和 disabled；value 可传字符串或数字，回调统一返回字符串。说明和积分应来自真实业务数据，不把设计包演示值写入页面。原有动态 option/optgroup children 与 `onChange(event)` 同样支持，不必改写模型能力、数值转换或筛选逻辑；onChange 和 onValueChange 都传入时都会调用一次。
- 支持 value/defaultValue、name/form、required、disabled、id、aria-label/labelledby/describedby/invalid、`size="md|sm"`（40/32px）、invalid、placeholder、clearable 和 searchable。请选择类空值默认作为占位隐藏；“全部角色/来源/状态”等有效空值保留在菜单中。clearable 会提供返回未选择的入口，超过八项默认出现搜索框，也可显式启用或关闭。
- 远程搜索可传 `onSearchChange`，展开时收到空串、输入时收到原始搜索词，外层负责防抖、真实 API 查询、AbortSignal 和结果 options；此模式组件不再二次筛选服务端结果。加载期间外层清空旧 options 并设置 `emptyMessage`，可用 `searchPlaceholder` 提示搜索字段；没有该回调时仍沿用本地过滤，不改变现有页面行为。
- 可用外部 `label htmlFor` 或包裹 label；label 关联可见触发器，不关联隐藏字段。无 aria-label 的现有表单自动读取标签正文，排除控件值和辅助说明。禁用的 fieldset 同样生效，必填校验失败聚焦可见触发器。错误原因/操作结果使用既有 Feedback；不要新增内联操作错误或 Toast。
- 点击、Enter/空格和方向键展开；菜单内方向键、Home/End 跳过禁用项，Enter/空格选择，600ms 内连续文字跳转。搜索支持选项名称、说明和分组；中文组词不误选择。Esc 只关闭菜单并回到触发器，Tab 继续页面焦点顺序；点外部、外部滚动、窗口缩放/失焦、触发器隐藏/禁用或位置变化时关闭，同一时间仅一个 Select 菜单。
- 菜单使用手动 popover 进入顶层，挂在 body 或所属原生 dialog 中，避开 overflow 与 transform 裁剪；底部空间不足时向上展开，8px 视口夹紧，列表最大 280px，内部滚动不传递到页面。触发器为 combobox、菜单为 listbox，选中与高亮分别通过 aria-selected/activedescendant 表达。保持暖白表面、10px 控件圆角、橙棕聚焦环和对勾，并支持减少动态效果。
- 悬停说明复用 Tooltip。Select 可置于 Tooltip 内，组件透传同一宿主的说明、标题、方向和延迟；不要使用 HTML title。页面 CSS 仅控制 `.app-select` 的宽度、间距和排列，共享触发器/菜单外观在 Select.css 中维护。

`npm run test:mock` 包含 Select 统一接入约束，以及占位/空值筛选、禁用项导航、搜索/前缀跳转、底部翻转和不同视口边界回归。浏览器测试用 `tests/selectTestHelpers.ts` 操作实际可见菜单，不通过隐藏字段绕过交互。

## DatePicker · 全局日期与日期时间

实现为 `apps/web/src/components/DatePicker.tsx`、DatePicker.css 和 datePickerBehavior.ts，参考 `public/ui-register/compoment/datepicker-component/`，没有新增依赖。所有需要选择日期或日期时间的表单统一复用；不要直接写原生 date/datetime-local 输入或另建日期面板。组件内部的隐藏原生字段负责 FormData、required 和原有 change 回调，用户操作可见文本框与日历。

```tsx
import DatePicker from '../../components/DatePicker';

<label>
  过期时间（可选）
  <DatePicker value={expires} onValueChange={setExpires} />
</label>

<DatePicker
  mode="date"
  aria-label="开始日期"
  name="start"
  defaultValue="2026-10-24"
  min="2026-01-01"
  max="2026-12-31"
/>
```

- 默认 `mode="datetime"`，值为本地 `YYYY-MM-DDTHH:mm`；`mode="date"` 值为 `YYYY-MM-DD`，空值为 `''`。显示使用斜线和空格，不附加 UTC 或时区偏移。业务提交时沿用原有时区转换；日期字段不能直接按 UTC 字符串解析，也不要在组件内部调用 toISOString。
- 支持 value/defaultValue、onValueChange、原 onChange(event)、name/form、id、required、disabled/readOnly、invalid、aria-label/labelledby/describedby/invalid 和共享 Tooltip 的 data-tip 属性。包裹 label 或外部 htmlFor 关联可见输入，必填失败聚焦可见输入；禁用 fieldset 同样有效。onChange 与 onValueChange 同时传入时各调用一次。
- min/max 按天包含边界，不限制同一天的小时或分钟；是否晚于当前时刻等业务规则仍由提交表单验证。minuteStep 默认 1，可设 5/10/15 等整数；它控制分钟列表和“此刻”的取整，手输保留合法分钟。日期时间每次选日/时/分立即更新；“确定”只关闭，仅日期选择后直接关闭。清除置空，改日期保留已有时间。
- 支持手输 `2026-10-24 13:52`、`2026/10/24`、`2026.10.24`，Enter/失焦提交；非法日期、无效闰日或越界输入还原上次有效值并短暂红框。Esc 放弃未提交文字；业务错误、风险警告和确认继续使用 Feedback；轻量操作结果使用下文共享 Toast，不新增页面横条。
- 周一开始、固定六周，月份面板支持跨年导航；日期网格包含今天/选中/键盘游标与不可选状态。输入框 ↓ 打开，再按 ↑↓ 或 Alt+←→ 进入日历游标，之后箭头按天/周移动，PageUp/PageDown 按月、Shift 按年移动，Enter 选择。未进入游标模式时左右键仍移动文字光标，中文组词不误提交；Esc/Tab 关闭，Tab 保持正常焦点顺序。
- 暖白 40px 输入、10px 圆角、橙棕聚焦环；面板 14px 圆角，日期时间在桌面并排，窄屏时间区下移。面板挂在 body 或所属原生 dialog 并进入手动 popover 顶层，避开 overflow/transform 裁剪；底部向上展开、8px 视口夹紧和内部独立滚动。点外部、外部滚动、缩放/失焦、输入隐藏/禁用/位移时关闭，同一时间仅打开一个日期面板。

`npm run test:mock` 包含全局 DatePicker 接入约束、非法/闰年日期、本地值往返、跨月年末导航、周一起始、边界日与视口定位回归。页面只控制组件宽度和间距，共享控件外观在 DatePicker.css 中维护。


## 积分调整共享表单

`features/wallet/CreditAdjustmentFields` 供积分管理页与用户管理的调整弹窗复用，统一增加/扣减、正整数金额、+10/+50/+100/+500 快捷值、可用余额预览、原因 Select 和补充说明；`CreditAdjustmentSummary` 复用同一分区确认内容。样式独立加载，不依赖先访问积分页。字段受父级状态控制，传入 amount/direction/reason/note、available、可选 limit 及变更回调；弹窗使用独立 idPrefix 和 initialFocus，busy/不确定结果由父级禁止编辑。组件不写账本、不发请求、不生成幂等键；单次额度、预占保护、至少 5 字说明、二次确认、权限和固定请求重试仍由业务入口与后端执行。


## Toast · 轻量操作反馈

按 `public/ui-register/compoment/toast-component/` 改为项目原生 React/TypeScript 组件，正式实现为 `components/Toast.tsx`、Toast.css 和 toastStore.ts。main 只挂一次 ToastHost；不加载原型脚本、不暴露 window.Toast、不执行演示中的随机结果或假撤销。全部既有 useToast 位置自动复用新版外观。

```tsx
const toast = useToast();
toast('任务 ID 已复制'); // 兼容原短调用，默认 success
toast('参数已填入', 'info');
toast.info('参数已填入', { description: '核对报价后点击生成。' });
const pending = toast.loading('正在同步', { id: 'sync', closable: false });
pending.update({ type: 'success', title: '同步完成', closable: true });
// pending.dismiss();
```

- `toast.show(options)` 或 `toast(options)`：title、description、type、duration、position、id、closable、action:{label,onClick}、onClose。对象默认 info；短字符串兼容调用默认 success。五类快捷方法 success/error/warning/info/loading 接 title 与可选 options。
- 默认 top-center，支持 top/bottom × left/center/right 六个位置；各位置最多 3 条，新提示贴近屏幕边缘，最旧条目被移除。相同来源重复复制去重并重新计时；显式相同 id 更新原条目，不影响别的 hook 同名 id。
- 成功/信息/警告默认 3000ms、错误 5000ms、loading 默认 0（常驻），duration:0 同样常驻。带操作且未指定时长时至少 6000ms；操作按钮不是假撤销，调用方须有真实可用逻辑。action 支持 Promise、防重复点击，失败保留可处理提示。onClose 在实际关闭/淘汰后调用，来源卸载时不调用已离开页面的回调。
- 返回句柄 `{id,update,dismiss}`，同一 hook 可用 `toast.update(id, patch)`、`toast.dismiss(id)`、`toast.dismissAll()`；关闭范围只限当前来源。update 重置倒计时/进度，loading 切换为 success/error 时重新应用默认时长。`toast.config({position,duration,errorDuration,max})` 配置全局默认值，仅新条目/后续更新取新默认。
- `toast.promise(promise,{loading,success,error})` 返回原 Promise，只跟踪结果，不发起、不重试或取消请求；success/error 可为返回文本的函数。同文案并发 Promise 保持独立提示，关闭或来源卸载后的结果不复活旧提示。不要用它替代金融/安全操作的确认、幂等或未知结果处理。
- 380px 最大宽、14px 圆角、32px 方块图标、14px 标题/13px 描述、28px 关闭按钮、底部 3px 倒计时；`--tt-*` 令牌集中管理颜色、尺寸和阴影。长提示用短标题加补充描述，移动端居中且保留 16px 边距。默认与当前项目保持亮色；仅显式 data-theme=dark 才启用暗色令牌，不会仅 Toast 随系统变暗。
- 240ms 入场/180ms 退场，悬停或键盘聚焦暂停计时与进度条，移开后继续剩余时间；loading 图标旋转，减少动态效果时关闭动画。error 用 role=alert，其余 role=status；按钮有可见焦点，提示不抢焦点、无遮罩。原生 modal 内使用同一宿主的 dialog 子树和非模态 popover 顶层，不改变业务弹窗开关。

只放简短纯文本，不放兑换码/密钥正文，不进查询缓存或持久化。复制、草稿/参数/连接、导出、本地撤销和显示名保存可用 Toast；积分、删除、安全与权限变更、业务/认证错误、金融未知结果和风险确认仍使用 Feedback 或专用弹窗。手动复制完整内容的弹窗保留，不按“成功”等关键词自动选择反馈通道。

`npm run test:mock` 包含倒计时暂停/续时、常驻/加载更新、来源 ID 隔离、有限堆叠、退场清理和 Promise 生命周期回归；全局契约限制单一 ToastHost，不新增页面自制 Toast/横条。
