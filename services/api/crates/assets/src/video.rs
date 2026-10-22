//! FFmpeg only consumes bounded uploaded bytes on stdin. No input file or URL.
use crate::{AssetError, MAX_VIDEO_BYTES};
use bytes::Bytes;
use serde_json::Value;
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

#[derive(Clone)]
pub struct VideoProcessor {
    wsl: bool,
    directory: Option<String>,
}
pub struct VideoInfo {
    pub width: i32,
    pub height: i32,
    pub duration_ms: i64,
}
pub struct PreparedVideo {
    pub original: Vec<u8>,
    pub thumbnail: Vec<u8>,
    pub info: VideoInfo,
}
impl VideoProcessor {
    pub fn from_lookup(
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<Option<Self>, &'static str> {
        let mode = lookup("VIDEO_MODE")
            .unwrap_or_else(|| if cfg!(windows) { "wsl" } else { "native" }.into());
        if mode == "disabled" {
            return Ok(None);
        }
        if !matches!(mode.as_str(), "native" | "wsl") || (mode == "native" && cfg!(windows)) {
            return Err("VIDEO_MODE");
        }
        let directory = lookup("FFMPEG_DIR").filter(|v| !v.trim().is_empty());
        if mode == "wsl"
            && directory
                .as_ref()
                .is_some_and(|v| !v.starts_with('/') || v.contains('\0'))
        {
            return Err("FFMPEG_DIR");
        }
        Ok(Some(Self {
            wsl: mode == "wsl",
            directory,
        }))
    }
    pub async fn available(&self) -> bool {
        for tool in ["ffmpeg", "ffprobe"] {
            if self
                .run(tool, &["-version"], Bytes::new(), 16384, 5)
                .await
                .is_err()
            {
                return false;
            }
        }
        true
    }
    async fn run(
        &self,
        tool: &str,
        args: &[&str],
        input: Bytes,
        max_output: usize,
        seconds: u64,
    ) -> Result<Vec<u8>, AssetError> {
        let program = self
            .directory
            .as_ref()
            .map(|dir| {
                if self.wsl {
                    format!("{}/{tool}", dir.trim_end_matches('/'))
                } else {
                    PathBuf::from(dir).join(tool).to_string_lossy().into_owned()
                }
            })
            .unwrap_or_else(|| tool.into());
        let mut command = if self.wsl {
            let mut cmd = Command::new("wsl.exe");
            cmd.args(["--exec", "timeout"]);
            cmd
        } else {
            Command::new("timeout")
        };
        command
            .args([
                "--signal=KILL",
                &format!("{seconds}s"),
                "prlimit",
                "--as=1073741824",
                "--",
                &program,
            ])
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| AssetError::VideoUnavailable)?;
        let mut stdin = child.stdin.take().ok_or(AssetError::Store)?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or(AssetError::Store)?
            .take(max_output as u64 + 1);
        let writer = tokio::spawn(async move {
            let result = stdin.write_all(&input).await;
            drop(stdin);
            result
        });
        let outcome = tokio::time::timeout(Duration::from_secs(seconds + 5), async {
            let mut output = Vec::new();
            stdout
                .read_to_end(&mut output)
                .await
                .map_err(|_| AssetError::Validation)?;
            if output.len() > max_output {
                return Err(AssetError::TooLarge);
            }
            let status = child.wait().await.map_err(|_| AssetError::Validation)?;
            if !status.success() {
                return Err(AssetError::Validation);
            }
            Ok(output)
        })
        .await;
        // Closing the bridge and stdin cannot leave an unbounded WSL child:
        // the independent Linux timeout also kills the process group.
        if !matches!(outcome, Ok(Ok(_))) {
            let _ = child.kill().await;
        }
        writer.abort();
        outcome.map_err(|_| AssetError::Validation)?
    }
    pub async fn inspect_upload(&self, input: Bytes, mime: &str) -> Result<VideoInfo, AssetError> {
        if input.is_empty() {
            return Err(AssetError::Validation);
        }
        if input.len() > MAX_VIDEO_BYTES {
            return Err(AssetError::TooLarge);
        }
        let mp4 = input.len() >= 12 && &input[4..8] == b"ftyp";
        let webm = input.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]);
        if !matches!(
            (mime, mp4, webm),
            ("video/mp4", true, _) | ("video/webm", _, true)
        ) {
            return Err(AssetError::Validation);
        }
        self.probe(input, 60.0).await
    }
    async fn probe(&self, input: Bytes, max_duration: f64) -> Result<VideoInfo, AssetError> {
        let output = self
            .run(
                "ffprobe",
                &[
                    "-v",
                    "error",
                    "-max_alloc",
                    "67108864",
                    "-protocol_whitelist",
                    "pipe,cache",
                    "-format_whitelist",
                    "mov,matroska,webm",
                    "-read_ahead_limit",
                    "2147483647",
                    "-i",
                    "cache:pipe:0",
                    "-show_streams",
                    "-show_format",
                    "-of",
                    "json",
                ],
                input,
                1024 * 1024,
                20,
            )
            .await?;
        let document: Value =
            serde_json::from_slice(&output).map_err(|_| AssetError::Validation)?;
        inspect_metadata(&document, max_duration)
    }
    pub async fn transcode(&self, input: Bytes) -> Result<PreparedVideo, AssetError> {
        let expected = self.probe(input.clone(), 60.0).await?;
        let output = self
            .run(
                "ffmpeg",
                &[
                    "-nostdin",
                    "-v",
                    "error",
                    "-max_alloc",
                    "67108864",
                    "-threads",
                    "2",
                    "-filter_threads",
                    "1",
                    "-protocol_whitelist",
                    "pipe,cache",
                    "-format_whitelist",
                    "mov,matroska,webm",
                    "-read_ahead_limit",
                    "2147483647",
                    "-i",
                    "cache:pipe:0",
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a:0?",
                    "-map_metadata",
                    "-1",
                    "-map_chapters",
                    "-1",
                    "-vf",
                    "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
                    "-r",
                    "30",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-pix_fmt",
                    "yuv420p",
                    "-threads",
                    "2",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-t",
                    "60",
                    "-fs",
                    "209715200",
                    "-movflags",
                    "frag_keyframe+empty_moov+default_base_moof",
                    "-f",
                    "mp4",
                    "pipe:1",
                ],
                input,
                MAX_VIDEO_BYTES,
                120,
            )
            .await?;
        let output = Bytes::from(output);
        // Only our freshly encoded output may include up to 100ms of AAC/frame
        // padding. Uploaded inputs always retain the strict 60-second limit.
        let info = self.probe(output.clone(), 60.1).await?;
        if (info.duration_ms - expected.duration_ms).abs() > 1000 {
            return Err(AssetError::Validation);
        }
        let jpeg = self
            .run(
                "ffmpeg",
                &[
                    "-nostdin",
                    "-v",
                    "error",
                    "-max_alloc",
                    "67108864",
                    "-threads",
                    "1",
                    "-filter_threads",
                    "1",
                    "-protocol_whitelist",
                    "pipe,cache",
                    "-format_whitelist",
                    "mov,matroska,webm",
                    "-read_ahead_limit",
                    "2147483647",
                    "-i",
                    "cache:pipe:0",
                    "-map",
                    "0:v:0",
                    "-map_metadata",
                    "-1",
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=480:480:force_original_aspect_ratio=decrease",
                    "-c:v",
                    "mjpeg",
                    "-threads",
                    "1",
                    "-f",
                    "image2pipe",
                    "pipe:1",
                ],
                output.clone(),
                2 * 1024 * 1024,
                20,
            )
            .await?;
        let prepared =
            tokio::task::spawn_blocking(move || crate::imaging::prepare(&jpeg, "image/jpeg"))
                .await
                .map_err(|_| AssetError::Store)??;
        Ok(PreparedVideo {
            original: output.to_vec(),
            thumbnail: prepared.thumbnail,
            info,
        })
    }
}
fn inspect_metadata(document: &Value, max_duration: f64) -> Result<VideoInfo, AssetError> {
    let streams = document["streams"]
        .as_array()
        .ok_or(AssetError::Validation)?;
    if streams.len() > 4 {
        return Err(AssetError::Validation);
    }
    let videos: Vec<_> = streams
        .iter()
        .filter(|stream| stream["codec_type"] == "video")
        .collect();
    if videos.len() != 1 {
        return Err(AssetError::Validation);
    }
    let video = videos[0];
    if !matches!(
        video["codec_name"].as_str(),
        Some("h264" | "hevc" | "vp8" | "vp9" | "av1")
    ) {
        return Err(AssetError::Validation);
    }
    let width = video["width"].as_i64().ok_or(AssetError::Validation)?;
    let height = video["height"].as_i64().ok_or(AssetError::Validation)?;
    if !(2..=4096).contains(&width) || !(2..=4096).contains(&height) || width * height > 9_000_000 {
        return Err(AssetError::TooLarge);
    }
    let duration = document["format"]["duration"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .ok_or(AssetError::Validation)?;
    if !duration.is_finite() || duration <= 0.0 || duration > max_duration {
        return Err(AssetError::TooLarge);
    }
    Ok(VideoInfo {
        width: width as i32,
        height: height as i32,
        duration_ms: ((duration * 1000.0).round() as i64).clamp(1, 60000),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn video_metadata_requires_bounded_duration_dimensions_and_supported_codec() {
        let valid = serde_json::json!({"streams":[{"codec_type":"video","codec_name":"h264","width":640,"height":360}],"format":{"duration":"2.0"}});
        assert_eq!(inspect_metadata(&valid, 60.0).unwrap().duration_ms, 2000);
        for (field, value) in [
            ("duration", "60.001"),
            ("duration", "61"),
            ("duration", "NaN"),
            ("duration", "inf"),
        ] {
            let mut bad = valid.clone();
            bad["format"][field] = value.into();
            assert!(inspect_metadata(&bad, 60.0).is_err());
        }
        let mut bad = valid.clone();
        bad["streams"][0]["width"] = 50000.into();
        assert!(inspect_metadata(&bad, 60.0).is_err());
        let mut bad = valid;
        bad["streams"][0]["codec_name"] = "unknown".into();
        assert!(inspect_metadata(&bad, 60.0).is_err());
    }
}
