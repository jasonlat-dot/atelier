use crate::CanvasError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use utoipa::ToSchema;
use uuid::Uuid;

pub const MAX_GRAPH_BYTES: usize = 2 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct NodeSize {
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Background {
    #[default]
    Dots,
    Lines,
    None,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct CanvasGraph {
    pub version: u8,
    pub nodes: Vec<CanvasNode>,
    pub edges: Vec<CanvasEdge>,
    pub viewport: Viewport,
    pub background: Background,
}
impl Default for CanvasGraph {
    fn default() -> Self {
        Self {
            version: 1,
            nodes: vec![],
            edges: vec![],
            viewport: Viewport {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            background: Background::Dots,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct CanvasNode {
    pub id: String,
    pub position: Point,
    pub size: NodeSize,
    #[serde(default)]
    pub locked: bool,
    #[serde(flatten)]
    pub content: NodeContent,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", content = "data", rename_all = "lowercase")]
pub enum NodeContent {
    Text(TextData),
    Image(ImageData),
    Video(VideoData),
    Generate(GenerateData),
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct TextData {
    pub text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    pub asset_id: Uuid,
    pub natural_w: u32,
    pub natural_h: u32,
    pub label: Option<String>,
    pub gen: Option<GenMeta>,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VideoData {
    pub asset_id: Uuid,
    pub natural_w: u32,
    pub natural_h: u32,
    pub duration_ms: Option<i64>,
    pub label: Option<String>,
    pub gen: Option<GenMeta>,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GenerateData {
    pub model_id: String,
    pub prompt: Option<String>,
    pub quality: String,
    pub ratio: String,
    pub resolution: String,
    pub n: u8,
    pub seconds: Option<u32>,
    pub status: Option<String>,
    pub job_id: Option<Uuid>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GenMeta {
    pub job_id: Uuid,
    pub model_id: String,
    pub prompt: String,
    pub quality: String,
    pub ratio: String,
    pub resolution: String,
    pub size: String,
    pub n: u8,
    pub references: Vec<Uuid>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EdgeRole {
    #[default]
    Reference,
    Prompt,
    Result,
    First,
    Last,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct CanvasEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub role: EdgeRole,
}
fn bounded(value: f64, max: f64) -> bool {
    value.is_finite() && value.abs() <= max
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn short(value: &str) -> bool {
    value.chars().count() <= 100 && !value.chars().any(char::is_control)
}
fn gen_valid(gen: &Option<GenMeta>) -> bool {
    gen.as_ref().is_none_or(|g| {
        short(&g.model_id)
            && g.prompt.chars().count() <= 4000
            && short(&g.quality)
            && short(&g.ratio)
            && short(&g.resolution)
            && short(&g.size)
            && (1..=4).contains(&g.n)
            && g.references.len() <= 4
    })
}
impl CanvasGraph {
    pub fn asset_ids(&self) -> Vec<Uuid> {
        let mut ids = HashSet::new();
        for node in &self.nodes {
            match &node.content {
                NodeContent::Image(d) => {
                    ids.insert(d.asset_id);
                    if let Some(g) = &d.gen {
                        ids.extend(g.references.iter().copied());
                    }
                }
                NodeContent::Video(d) => {
                    ids.insert(d.asset_id);
                    if let Some(g) = &d.gen {
                        ids.extend(g.references.iter().copied());
                    }
                }
                _ => {}
            }
        }
        let mut ids: Vec<_> = ids.into_iter().collect();
        ids.sort();
        ids
    }
    pub fn validate(&self) -> Result<(), CanvasError> {
        if self.asset_ids().len() > 500 {
            return Err(CanvasError::Validation);
        }
        if self.version != 1
            || self.nodes.len() > 500
            || self.edges.len() > 1000
            || !bounded(self.viewport.x, 1e6)
            || !bounded(self.viewport.y, 1e6)
            || !self.viewport.zoom.is_finite()
            || !(0.1..=4.).contains(&self.viewport.zoom)
            || serde_json::to_vec(self)
                .map_err(|_| CanvasError::Validation)?
                .len()
                > MAX_GRAPH_BYTES
        {
            return Err(CanvasError::Validation);
        }
        let mut nodes = HashMap::new();
        for node in &self.nodes {
            if !identifier(&node.id)
                || nodes.insert(node.id.as_str(), node).is_some()
                || !bounded(node.position.x, 1e6)
                || !bounded(node.position.y, 1e6)
                || !(60.0..=4096.).contains(&node.size.width)
                || !(60.0..=4096.).contains(&node.size.height)
            {
                return Err(CanvasError::Validation);
            }
            let valid = match &node.content {
                NodeContent::Text(d) => d.text.chars().count() <= 20000,
                NodeContent::Image(d) => {
                    !d.asset_id.is_nil()
                        && (1..=32768).contains(&d.natural_w)
                        && (1..=32768).contains(&d.natural_h)
                        && d.label.as_ref().is_none_or(|s| short(s))
                        && gen_valid(&d.gen)
                }
                NodeContent::Video(d) => {
                    !d.asset_id.is_nil()
                        && (1..=32768).contains(&d.natural_w)
                        && (1..=32768).contains(&d.natural_h)
                        && d.duration_ms.is_none_or(|v| (1..=60000).contains(&v))
                        && d.label.as_ref().is_none_or(|s| short(s))
                        && gen_valid(&d.gen)
                }
                NodeContent::Generate(d) => {
                    short(&d.model_id)
                        && d.prompt.as_ref().is_none_or(|s| s.chars().count() <= 4000)
                        && short(&d.quality)
                        && short(&d.ratio)
                        && short(&d.resolution)
                        && (1..=4).contains(&d.n)
                        && d.seconds.is_none_or(|v| (1..=60).contains(&v))
                        && d.status.as_ref().is_none_or(|s| {
                            matches!(
                                s.as_str(),
                                "IDLE"
                                    | "QUEUED"
                                    | "ROUTING"
                                    | "RUNNING"
                                    | "STORING"
                                    | "SUCCEEDED"
                                    | "PARTIAL"
                                    | "FAILED"
                                    | "CANCELLED"
                            )
                        })
                        && d.error.as_ref().is_none_or(|s| short(s))
                }
            };
            if !valid {
                return Err(CanvasError::Validation);
            }
        }
        let mut ids = HashSet::new();
        let mut pairs = HashSet::new();
        let mut incoming: HashMap<&str, usize> = nodes.keys().map(|id| (*id, 0)).collect();
        let mut next: HashMap<&str, Vec<&str>> = HashMap::new();
        for e in &self.edges {
            let (Some(source), Some(target)) =
                (nodes.get(e.source.as_str()), nodes.get(e.target.as_str()))
            else {
                return Err(CanvasError::Validation);
            };
            let valid = matches!(
                (&source.content, &target.content, &e.role),
                (
                    NodeContent::Text(_),
                    NodeContent::Generate(_),
                    EdgeRole::Prompt
                ) | (
                    NodeContent::Image(_),
                    NodeContent::Generate(_),
                    EdgeRole::Reference | EdgeRole::First | EdgeRole::Last
                ) | (
                    NodeContent::Generate(_),
                    NodeContent::Image(_) | NodeContent::Video(_),
                    EdgeRole::Result
                )
            );
            if !valid
                || !identifier(&e.id)
                || e.source == e.target
                || !ids.insert(&e.id)
                || !pairs.insert((&e.source, &e.target))
            {
                return Err(CanvasError::Validation);
            }
            *incoming
                .get_mut(e.target.as_str())
                .ok_or(CanvasError::Validation)? += 1;
            next.entry(&e.source).or_default().push(&e.target);
        }
        let mut queue: VecDeque<_> = incoming
            .iter()
            .filter(|(_, n)| **n == 0)
            .map(|(id, _)| *id)
            .collect();
        let mut visited = 0;
        while let Some(id) = queue.pop_front() {
            visited += 1;
            for target in next.get(id).into_iter().flatten() {
                let n = incoming.get_mut(target).ok_or(CanvasError::Validation)?;
                *n -= 1;
                if *n == 0 {
                    queue.push_back(target);
                }
            }
        }
        if visited != nodes.len() {
            return Err(CanvasError::Validation);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn text(id: &str) -> CanvasNode {
        CanvasNode {
            id: id.into(),
            position: Point { x: 0., y: 0. },
            size: NodeSize {
                width: 240.,
                height: 160.,
            },
            locked: false,
            content: NodeContent::Text(TextData {
                text: "Prompt".into(),
            }),
        }
    }
    #[test]
    fn graph_bounds_and_unknown_fields_are_enforced() {
        let mut g = CanvasGraph::default();
        g.nodes.push(text("a"));
        let mut raw = serde_json::to_value(&g).unwrap();
        raw["upstream_key"] = "secret".into();
        raw["nodes"][0]["data"]["url"] = "http://localhost/private".into();
        let clean: CanvasGraph = serde_json::from_value(raw).unwrap();
        clean.validate().unwrap();
        let raw = serde_json::to_string(&clean).unwrap();
        assert!(!raw.contains("secret") && !raw.contains("localhost"));
        g.nodes.push(text("a"));
        assert!(g.validate().is_err());
        g.nodes.pop();
        g.viewport.zoom = 0.09;
        assert!(g.validate().is_err());
        g.viewport.zoom = 1.;
        if let NodeContent::Text(d) = &mut g.nodes[0].content {
            d.text = "a".repeat(20001);
        }
        assert!(g.validate().is_err());
        g.nodes = (0..500).map(|n| text(&format!("n{n}"))).collect();
        g.validate().unwrap();
        g.nodes.push(text("extra"));
        assert!(g.validate().is_err());
    }
    #[test]
    fn rejects_cycles_missing_nodes_and_invalid_semantic_edges() {
        let id = Uuid::new_v4();
        let mut g = CanvasGraph::default();
        g.nodes.push(CanvasNode {
            id: "image".into(),
            content: NodeContent::Image(ImageData {
                asset_id: id,
                natural_w: 100,
                natural_h: 100,
                label: None,
                gen: None,
            }),
            ..text("unused")
        });
        g.nodes.push(CanvasNode {
            id: "gen".into(),
            content: NodeContent::Generate(GenerateData {
                model_id: "image".into(),
                prompt: None,
                quality: "low".into(),
                ratio: "1:1".into(),
                resolution: "1K".into(),
                n: 1,
                seconds: None,
                status: None,
                job_id: None,
                error: None,
            }),
            ..text("unused")
        });
        g.edges.push(CanvasEdge {
            id: "e1".into(),
            source: "image".into(),
            target: "gen".into(),
            role: EdgeRole::Reference,
        });
        g.validate().unwrap();
        g.edges.push(CanvasEdge {
            id: "e2".into(),
            source: "gen".into(),
            target: "image".into(),
            role: EdgeRole::Result,
        });
        assert!(g.validate().is_err());
        g.edges.pop();
        g.edges[0].role = EdgeRole::Prompt;
        assert!(g.validate().is_err());
        g.edges[0].role = EdgeRole::Reference;
        g.edges[0].target = "missing".into();
        assert!(g.validate().is_err());
    }
}
