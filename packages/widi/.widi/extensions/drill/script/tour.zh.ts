import { LAST_SPAWNED_AGENT, text, thinking, toolCall } from "./beats.ts";
import { DRILL_HELPER_PROFILE_ID } from "./tour.en.ts";
import type { DrillScript } from "./types.ts";

const HELPER_TASK = "数到三，然后停下。";

/** The Chinese tour. A translation of `tourEn`, beat for beat and id for id. */
export const tourZh: DrillScript = {
	language: "zh",
	title: "WIDI 导览",
	estimatedMinutes: 3,
	steps: [
		{
			id: "tour.welcome",
			chapter: "tour",
			narrate: [
				"欢迎。这是一次排练，大约需要三分钟。",
				"",
				"它就在这里跑，用你已经打开的这个 agent。没有为它新建任何东西，",
				"结束之后也不会拿走任何东西。开始的时候只改了两样——模型换成了一个",
				"写死剧本的假模型，另外临时打开了几个只读工具——结束时都会换回去。",
				"",
				"WIDI 是一个建在 pi 之上的多 agent 编排器，感谢 pi 的贡献者。",
				"",
				"顺便说一句，我不是 WIDI。我是 drill，一个扩展。接下来每做一件事，",
				"我都会说一遍我是怎么做到的。",
			],
			pause: "不用急。想开始的时候按推进键。",
			review: [
				"那个键是我的。我用 registerShortcut 把它注册成了 ext.drill.next，",
				"它和所有内建键位在同一张表里——所以它会出现在底栏，",
				"你也可以在 keybindings.json 里像改任何其他动作一样改掉它。",
				"",
				"我同时是两半。一半跑在这个 agent 里面，够得着模型、工具和会话；",
				"另一半跑在终端这边，够得着屏幕。它们互相看不见，只通过一条事件总线说话。",
			],
		},
		{
			id: "tour.intro",
			chapter: "tour",
			narrate: [
				"先来一个直白的问题和一个直白的回答。",
				"",
				"下面这句话已经等在你的输入框里了。读一遍，",
				"然后自己按回车——我不会替你发送任何东西。",
			],
			say: "你是什么？",
			turns: [
				[
					thinking("对方是第一次来。先说我是什么，别急着说我能做什么。"),
					text(
						"我是 WIDI：一个你在终端里对话的编排器。\n\n一段对话就是一个 **agent**。我可以同时跑好几个，在它们之间传递工作，并把其中任意一个显示给你。",
					),
				],
			],
			review: [
				"刚才那是真的一轮：输入框、命令引擎、编排器、harness、provider。",
				"除了最后一环，每一环都是正式代码。",
				"",
				"怎么做到的：我用 registerProvider 注册了一个 provider，然后在导览期间",
				"把这个 agent 指向它。上游没有任何一层能分辨出差别——排练之所以有价值",
				"正是因为这一点。如果我直接伪造记录，那它就证明不了真实路径上的任何事。",
				"",
				"那句台词是通过 editor 能力面的 setText 进到你输入框的。注意我做不到什么：",
				"没有 submit。往你输入框里写字是我的事，按回车是你的事，",
				"落到分支上的那条记录也会写明它是你的。",
			],
			watch: "回复上面那个思考块：默认折叠，ctrl+o 展开。",
		},
		{
			id: "tour.tools",
			chapter: "tour",
			narrate: [
				"接下来是工具。WIDI 有一套内建工具——读取、搜索、编辑、执行命令，",
				"在这里它们不是假的。",
				"",
				"下面这句话会真的用一次。注意问题和回答之间冒出来的那张卡片，",
				"那就是工具调用本身。",
			],
			say: "这个目录里有什么？",
			turns: [
				[thinking("先看，再回答。"), toolCall("ls", { path: "." })],
				[
					text(
						"那就是你启动我时所在的目录，由真正的 `ls` 工具列出来的——" +
							"和正式运行走的是同一段代码，屏幕上也是同一张卡片。",
					),
				],
			],
			review: [
				"工具调用是真的，只有它周围那句话是提前写好的。",
				"",
				"怎么做到的：工具是 core 的，不是我的——我只是请求在导览期间打开几个。",
				"只有读和派活，没有任何能写、能执行的。",
				"扩展也可以注册自己的工具、给内建工具打补丁，",
				"但一次导览没有理由往你的磁盘上写东西。",
			],
			watch: "那张工具卡片：能折叠、能逐条展开、还会印出这次调用花了多久。",
		},
		{
			id: "tour.agents",
			chapter: "tour",
			narrate: [
				"现在到了名字所指的那部分。WIDI 是一个编排器，不是一个 agent：",
				"它可以再建一个 agent，把活交给它，然后继续做自己的事。",
				"",
				"下面这句话就是让它这么做。建出来的助手是一段独立的对话，",
				"有它自己的上下文——它看不见这一段。",
			],
			say: "派一个助手去数到三。",
			turns: [
				[
					thinking("小活，不需要上下文。用 helper 角色新建一个就够了。"),
					toolCall("spawn_agent", { agents: [{ profile: DRILL_HELPER_PROFILE_ID, task: HELPER_TASK, watch: false }] }),
				],
				[
					text(
						"好了。这个助手是它自己的 agent，有自己的记录，任务已经在它手上。\n\n" +
							"我没有在等它。真干活的时候我会要求它停下来时叫醒我；这里你自己过去看一眼就行。",
					),
				],
			],
			review: [
				"看屏幕底部那条 strip：现在有两个 agent 了，缩进表示谁建了谁。",
				"那是一棵树，不是一个列表。",
				"",
				"怎么做到的：派 agent 需要一个角色，而我不可能知道你机器上有哪些角色——",
				"这次导览是在你启动时所在的目录里跑的。所以我自带了一个。",
				"我加载的时候用 registerProfile 注册了 drill-helper，",
				"它不需要写进你的设置里，而你自己写的同名角色会盖过我的。",
			],
			watch: "agent strip 上新出现的那一行，以及它在这一行下面的缩进。",
		},
		{
			id: "tour.strip",
			chapter: "tour",
			narrate: [
				"那个助手你可以自己过去看看。",
				"",
				"输入框是空的时候，在末尾按下方向键，agent 面板就打开了。",
				"左右移动，回车把某一个放到屏幕上。切到哪一个，哪一个的完整记录就在那里——",
				"每个 agent 各留各的。",
				"",
				"看完了再回到这一个。导览会等你。",
			],
			pause: "现在试试下方向键，回来之后按推进键。",
		},
		{
			id: "tour.dispose",
			chapter: "tour",
			narrate: ["不再需要的 agent 不会自己消失。", "委派是一个有终点的循环，这里就是它的终点。"],
			say: "把那个助手收掉。",
			turns: [
				[toolCall("dispose_agent", { agentIds: [LAST_SPAWNED_AGENT], reason: "the rehearsal is done with it" })],
				[text("助手已经关掉了。它的会话被保留下来，所以同一段对话以后可以重新打开，" + "而不是从零再来一遍。")],
			],
			review: [
				"怎么做到的：剧本是运行之前写好的，agent id 是运行当中才发出来的，",
				"所以那个参数是我唯一写不出来的东西。provider 从 spawn 自己的工具结果里",
				"把它读回来填了进去。这几轮里其余的东西全是字面量。",
			],
			watch: "助手那一行从 strip 上消失。",
		},
		{
			id: "tour.interface",
			chapter: "tour",
			narrate: [
				"WIDI 的另一半是这块屏幕，它不是装饰。",
				"",
				"我对你说的每一行都是扩展行：我用 chat 能力面把它们放上去，",
				"它们不占任何一轮，也不在任何分支上——明天重新打开这个会话，",
				"我这些旁白一句都不会回来。",
				"",
				"进度文字和键位提示是 segment，分别在工作行和底栏上。开场那条横幅是 notice。",
				"扩展还可以先把一句话摆进你的输入框让你改或者丢掉，",
				"可以在 agent 忙的时候排队，再把整批队列变成一次打断。",
				"",
				"配色也是你的。试试 /theme prism，或者 /theme default 换回来。",
			],
			pause: "现在可以试试 /theme：整屏重绘，什么都不用重启。",
			review: [
				"最后一条「怎么做到的」。我声明了一个叫 tour 的 division，",
				"你刚才看到的一切都注册在它里面——所以 /division drill/tour 能把整个东西关掉，",
				"而且关掉的 division 是「根本不注册」，不是「注册了再跳过」。",
			],
		},
		{
			id: "tour.close",
			chapter: "tour",
			narrate: [
				"导览到此为止。你的模型和工具会换回原来的样子。",
				"",
				"下面这张表是这一趟真正碰到的东西。它是数出来的，不是提前写好的，",
				"所以它没法替任何人说好话——包括我。",
			],
		},
	],
	asides: [{ line: HELPER_TASK, turns: [[text("一。\n\n二。\n\n三。\n\n数完了。这里没有别的事了。")]] }],
	reportTitle: "这次 drill 真正演到的面",
	reportColumns: ["面", "结果"],
	closing: "WIDI 还年轻。上面这张表是它今天真的做到的，不是它希望做到的。",
};
