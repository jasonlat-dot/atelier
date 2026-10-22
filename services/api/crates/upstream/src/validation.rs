use crate::{Capabilities, Error};
use std::collections::HashSet;
pub fn label(value: &str, max: usize) -> Result<(), Error> {
    if value.trim() != value
        || value.is_empty()
        || value.chars().count() > max
        || value.chars().any(char::is_control)
    {
        return Err(Error::Validation);
    }
    Ok(())
}
pub fn identifier(value: &str, max: usize) -> Result<(), Error> {
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Err(Error::Validation);
    }
    Ok(())
}
pub fn quota(total: i64, remaining: i64) -> Result<(), Error> {
    if !(1..=1_000_000_000_000).contains(&total) || !(0..=total).contains(&remaining) {
        return Err(Error::Validation);
    }
    Ok(())
}
fn choices(values: &[String], allowed: &[&str], empty: bool) -> Result<(), Error> {
    if (!empty && values.is_empty())
        || values.len() > allowed.len()
        || values.iter().any(|v| !allowed.contains(&v.as_str()))
        || values.iter().collect::<HashSet<_>>().len() != values.len()
    {
        return Err(Error::Validation);
    }
    Ok(())
}
pub fn capabilities(kind: &str, caps: &Capabilities) -> Result<(), Error> {
    if !(1..=4).contains(&caps.max_n)
        || caps.max_refs > 4
        || !matches!(caps.size_mode.as_str(), "flex" | "enum")
        || caps.sizes.len() > 64
    {
        return Err(Error::Validation);
    }
    match kind {
        "image" => {
            choices(&caps.qualities, &["low", "medium", "high"], false)?;
            choices(
                &caps.ratios,
                &["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"],
                false,
            )?;
            choices(&caps.resolutions, &["1K", "2K", "4K"], false)?;
            if !caps.seconds.is_empty() || (caps.supports_edit && caps.max_refs == 0) {
                return Err(Error::Validation);
            }
        }
        "video" => {
            choices(&caps.qualities, &["standard"], false)?;
            choices(&caps.ratios, &["1:1", "16:9", "9:16"], false)?;
            choices(&caps.resolutions, &["720p", "1080p"], false)?;
            if caps.max_n != 1
                || caps.max_refs > 1
                || caps.supports_edit
                || caps.seconds.is_empty()
                || caps.seconds.len() > 16
                || caps.seconds.iter().any(|n| !(1..=60).contains(n))
                || caps.seconds.iter().collect::<HashSet<_>>().len() != caps.seconds.len()
            {
                return Err(Error::Validation);
            }
        }
        "chat" => {
            choices(&caps.qualities, &["message"], false)?;
            if !caps.ratios.is_empty()
                || caps.resolutions != ["text"]
                || caps.max_n != 1
                || caps.max_refs != 0
                || !caps.seconds.is_empty()
                || caps.supports_edit
                || !caps.sizes.is_empty()
            {
                return Err(Error::Validation);
            }
            return Ok(());
        }
        _ => return Err(Error::Validation),
    }
    if (caps.size_mode == "enum") != (!caps.sizes.is_empty()) {
        return Err(Error::Validation);
    }
    for size in &caps.sizes {
        let (w, h) = dimensions(size)?;
        let alignment = if kind == "image" { 16 } else { 2 };
        if w % alignment != 0 || h % alignment != 0 || w.max(h) > 3 * w.min(h) {
            return Err(Error::Validation);
        }
    }
    Ok(())
}
pub fn dimensions(size: &str) -> Result<(u32, u32), Error> {
    let (w, h) = size.split_once('x').ok_or(Error::Validation)?;
    let w: u32 = w.parse().map_err(|_| Error::Validation)?;
    let h: u32 = h.parse().map_err(|_| Error::Validation)?;
    if !(16..=4096).contains(&w) || !(16..=4096).contains(&h) {
        return Err(Error::Validation);
    }
    Ok((w, h))
}
pub fn size_for(
    kind: &str,
    ratio: &str,
    resolution: &str,
    caps: &Capabilities,
) -> Result<String, Error> {
    if !caps.ratios.iter().any(|v| v == ratio) || !caps.resolutions.iter().any(|v| v == resolution)
    {
        return Err(Error::Validation);
    }
    let (a, b) = ratio.split_once(':').ok_or(Error::Validation)?;
    let a: f64 = a.parse().map_err(|_| Error::Validation)?;
    let b: f64 = b.parse().map_err(|_| Error::Validation)?;
    let long = match resolution {
        "1K" => 1024.,
        "2K" => 2048.,
        "4K" => 3840.,
        "720p" => 1280.,
        "1080p" => 1920.,
        _ => return Err(Error::Validation),
    };
    let (w, h) = if a >= b {
        (long, long * b / a)
    } else {
        (long * a / b, long)
    };
    if caps.size_mode == "enum" {
        return caps
            .sizes
            .iter()
            .filter_map(|s| {
                dimensions(s)
                    .ok()
                    .map(|(x, y)| (s, ((x as f64 / w).ln()).abs() + ((y as f64 / h).ln()).abs()))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(s, _)| s.clone())
            .ok_or(Error::Validation);
    }
    let step = if kind == "video" { 2. } else { 16. };
    let w = (w / step).round() * step;
    let h = (h / step).round() * step;
    let size = format!("{}x{}", w as u32, h as u32);
    dimensions(&size)?;
    Ok(size)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capabilities_and_sizes_are_server_validated() {
        let mut caps:Capabilities=serde_json::from_value(serde_json::json!({"qualities":["low","high"],"ratios":["16:9","21:9"],"resolutions":["1K","4K"],"max_n":4,"max_refs":4,"supports_edit":true})).unwrap();
        capabilities("image", &caps).unwrap();
        assert_eq!(size_for("image", "16:9", "4K", &caps).unwrap(), "3840x2160");
        assert!(size_for("image", "1:1", "4K", &caps).is_err());
        caps.size_mode = "enum".into();
        caps.sizes = vec!["1024x1024".into(), "1536x1024".into()];
        assert_eq!(size_for("image", "16:9", "1K", &caps).unwrap(), "1024x1024");
        caps.max_n = 99;
        assert!(capabilities("image", &caps).is_err());
    }
}
