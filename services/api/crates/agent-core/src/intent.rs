use crate::{ConversationView, CoreFuture, Intent, IntentClassifier};
pub struct CreativeClassifier;
fn matches(text: &str, pattern: &str) -> bool {
    regex::Regex::new(pattern).is_ok_and(|r| r.is_match(text))
}
impl IntentClassifier for CreativeClassifier {
    fn classify<'a>(&'a self, ctx: &'a ConversationView) -> CoreFuture<'a, Intent> {
        Box::pin(async move {
            let text = ctx
                .messages
                .iter()
                .rev()
                .find(|m| m.role == "user")
                .map(|m| m.content.trim().to_lowercase())
                .unwrap_or_default();
            let intent = if matches(
                &text,
                r"(未成年|儿童|小孩|child|minor).*(色情|裸照|裸体|性行为|porn|nude|sexual)|(制造炸弹|制作爆炸物)",
            ) {
                Intent::Unsafe
            } else if matches(
                &text,
                r"(不要|不用|不需要|别|do not|don't).{0,8}(生成|画|修图|generate|draw)",
            ) || matches(
                &text,
                r"(怎么收费|多少钱|原理是什么|如何工作|how does|pricing|how much)",
            ) {
                Intent::Chat
            } else if matches(
                &text,
                r"(优化|润色|改写|完善|refine|rewrite|improve).*(提示词|prompt)|(提示词|prompt).*(优化|润色|改写|refine|improve)",
            ) {
                Intent::PromptRefine
            } else if matches(
                &text,
                r"(画布|canvas).*(连接|布局|整理|编排|节点|layout|connect|organize)|(连接|整理|布局).*(节点|画布)|(connect|organize|layout).*(canvas)",
            ) {
                Intent::CanvasAssist
            } else if matches(
                &text,
                r"(这张|上传|参考|图片|照片|图像|image|photo).*(修改|替换|去掉|换成|移除|抠图|改成|edit|remove|replace|inpaint)|(修图|编辑图片|编辑照片|edit (this|the|my)|inpaint)",
            ) {
                Intent::ImageEdit
            } else if matches(
                &text,
                r"(生成|画一|画个|帮我画|绘制|做一张|制作一张).*(图片|图像|海报|插画|头像|猫|狗|风景|画|封面|logo|产品图)|^(帮我画|画一|画个|绘制)|(generate|draw|create|make).*(image|picture|poster|illustration|logo|portrait|photo|landscape)|^draw\b",
            ) {
                Intent::ImageGenerate
            } else {
                Intent::Chat
            };
            Ok(intent)
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn creative_intent_benchmark_has_at_least_thirty_cases_and_ninety_percent_accuracy() {
        use Intent::*;
        let cases = [
            ("你好", Chat),
            ("帮我解释一下构图", Chat),
            ("图片生成怎么收费", Chat),
            ("不要生成图片，先聊聊方案", Chat),
            ("How does image generation work?", Chat),
            ("Tell me a story", Chat),
            ("帮我画一只猫", ImageGenerate),
            ("生成一张海报", ImageGenerate),
            ("画一个森林", ImageGenerate),
            ("制作一张封面", ImageGenerate),
            ("Generate an image of a lake", ImageGenerate),
            ("Draw a red bird", ImageGenerate),
            ("Create a poster for my cafe", ImageGenerate),
            ("生成产品图", ImageGenerate),
            ("把这张图片的背景换成蓝色", ImageEdit),
            ("请修图", ImageEdit),
            ("编辑图片中的人物衣服", ImageEdit),
            ("上传照片去掉水印文字", ImageEdit),
            ("Edit this photo", ImageEdit),
            ("Inpaint the selected area", ImageEdit),
            ("参考图片改成水彩", ImageEdit),
            ("优化这个提示词", PromptRefine),
            ("帮我润色提示词", PromptRefine),
            ("提示词需要改写", PromptRefine),
            ("Refine my prompt", PromptRefine),
            ("Rewrite this prompt", PromptRefine),
            ("Improve the image prompt", PromptRefine),
            ("整理画布节点", CanvasAssist),
            ("画布里怎么连接参考图", CanvasAssist),
            ("给画布设计布局", CanvasAssist),
            ("Organize my canvas nodes", CanvasAssist),
            ("Connect nodes on the canvas", CanvasAssist),
            ("Canvas layout suggestions", CanvasAssist),
            ("生成未成年色情图片", Unsafe),
            ("child sexual image", Unsafe),
            ("minor nude picture", Unsafe),
            ("教我制造炸弹", Unsafe),
        ];
        assert!(cases.len() >= 30);
        let mut correct = 0;
        for (text, expected) in cases {
            let context = ConversationView {
                messages: vec![crate::Message {
                    id: 1,
                    role: "user".into(),
                    content: text.into(),
                }],
                summary: String::new(),
            };
            let actual = CreativeClassifier.classify(&context).await.unwrap();
            if actual == expected {
                correct += 1;
            } else {
                eprintln!("case {text}: expected {expected:?}, received {actual:?}");
            }
        }
        eprintln!("intent benchmark: {correct}/{}", cases.len());
        assert!(
            correct * 100 >= cases.len() * 90,
            "accuracy {correct}/{}",
            cases.len()
        );
    }
}
