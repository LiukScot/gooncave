use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde_json::Value;
use tokio::process::Command;

use crate::{Error, Result};

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "avif",
];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv", "m4v"];
// Same limit as the reference scanner: one unreadable file must not stall a scan.
const TOOL_TIMEOUT: Duration = Duration::from_secs(30);
const THUMB_BOX: u32 = 400;
/// Narrowest width/height kept whole; the grid crops anything narrower to 1:2.
const THUMB_TALLEST_RATIO: f64 = 0.5;
/// Frames kept in an animated thumbnail; a tile only needs enough to read as moving.
const ANIMATED_THUMB_MAX_FRAMES: u32 = 120;
pub(crate) const CROPPED_THUMB_SUFFIX: &str = "-crop.jpg";
pub(crate) const ANIMATED_THUMB_SUFFIX: &str = "-animated.webp";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "IMAGE",
            Self::Video => "VIDEO",
        }
    }
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
}

pub fn detect_kind(path: &Path) -> Option<MediaKind> {
    let extension = extension(path)?;
    if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaKind::Image)
    } else if VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        Some(MediaKind::Video)
    } else {
        None
    }
}

pub fn is_gif(path: &Path) -> bool {
    extension(path).as_deref() == Some("gif")
}

pub fn is_strip(width: Option<i64>, height: Option<i64>) -> bool {
    matches!((width, height), (Some(width), Some(height)) if height > 0 && (width as f64) / (height as f64) < THUMB_TALLEST_RATIO)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Probe {
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
}

async fn run(program: &str, arguments: &[&std::ffi::OsStr]) -> Result<Vec<u8>> {
    let child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            Error::Storage(format!(
                "cannot start {program}: {error}. Install FFmpeg to read media files."
            ))
        })?;
    let output = tokio::time::timeout(TOOL_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| Error::Storage(format!("{program} timed out")))??;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(Error::Storage(format!(
            "{program} failed: {}",
            message.lines().last().unwrap_or("no output")
        )));
    }
    Ok(output.stdout)
}

/// EXIF orientation (1 through 8); 1 when the file has none or it cannot be read.
fn orientation(path: &Path) -> u32 {
    let Ok(file) = std::fs::File::open(path) else {
        return 1;
    };
    exif::Reader::new()
        .read_from_container(&mut std::io::BufReader::new(file))
        .ok()
        .and_then(|exif| {
            exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                .and_then(|field| field.value.get_uint(0))
        })
        .filter(|value| (1..=8).contains(value))
        .unwrap_or(1)
}

// Applied by hand with -noautorotate so every FFmpeg version rotates photos the same way.
fn orientation_filter(orientation: u32) -> Option<&'static str> {
    match orientation {
        2 => Some("hflip"),
        3 => Some("hflip,vflip"),
        4 => Some("vflip"),
        5 => Some("transpose=0"),
        6 => Some("transpose=1"),
        7 => Some("transpose=3"),
        8 => Some("transpose=2"),
        _ => None,
    }
}

fn with_orientation(kind: MediaKind, path: &Path, filter: String) -> String {
    match (kind, orientation_filter(orientation(path))) {
        (MediaKind::Image, Some(rotate)) => format!("{rotate},{filter}"),
        _ => filter,
    }
}

/// Width and height as displayed (after EXIF rotation) and the duration of videos.
pub async fn probe(path: &Path, kind: MediaKind) -> Result<Probe> {
    let output = run(
        "ffprobe",
        &[
            "-v".as_ref(),
            "error".as_ref(),
            "-print_format".as_ref(),
            "json".as_ref(),
            "-show_streams".as_ref(),
            "-show_format".as_ref(),
            path.as_os_str(),
        ],
    )
    .await?;
    let report: Value = serde_json::from_slice(&output)
        .map_err(|error| Error::Storage(format!("invalid ffprobe report: {error}")))?;
    let stream = report["streams"].as_array().and_then(|streams| {
        streams.iter().find(|stream| {
            stream["codec_type"] == "video"
                && stream["width"].as_i64().is_some_and(|width| width > 0)
                && stream["height"].as_i64().is_some_and(|height| height > 0)
        })
    });
    let Some(stream) = stream else {
        return Err(Error::Storage("no picture in media file".into()));
    };
    let (mut width, mut height) = (stream["width"].as_i64(), stream["height"].as_i64());
    if kind == MediaKind::Image && orientation(path) >= 5 {
        std::mem::swap(&mut width, &mut height);
    }
    let duration_ms = match kind {
        MediaKind::Image => None,
        MediaKind::Video => report["format"]["duration"]
            .as_str()
            .and_then(|duration| duration.parse::<f64>().ok())
            .map(|seconds| (seconds * 1000.0).round() as i64),
    };
    Ok(Probe {
        width,
        height,
        duration_ms,
    })
}

/// Whether the bytes are a picture or video FFmpeg can decode as `kind`.
pub async fn content_matches(path: &Path, kind: MediaKind) -> bool {
    let sniffed =
        infer::get_from_path(path)
            .ok()
            .flatten()
            .and_then(|kind| match kind.matcher_type() {
                infer::MatcherType::Image => Some(MediaKind::Image),
                infer::MatcherType::Video => Some(MediaKind::Video),
                _ => None,
            });
    match sniffed {
        Some(sniffed) => sniffed == kind,
        // Some containers (WMV/ASF) have no signature the sniffer knows; the decoder decides.
        None => probe(path, kind).await.is_ok(),
    }
}

/// Writes the grid thumbnail into `directory`, named from `hint` and the rule that produced it.
pub async fn thumbnail(
    path: &Path,
    kind: MediaKind,
    probe: Probe,
    directory: &Path,
    hint: &str,
) -> Result<PathBuf> {
    tokio::fs::create_dir_all(directory).await?;
    let crop = kind == MediaKind::Image && is_strip(probe.width, probe.height);
    let animated = kind == MediaKind::Image && is_gif(path);
    let name = format!(
        "{hint}{}",
        if animated {
            ANIMATED_THUMB_SUFFIX
        } else if crop {
            CROPPED_THUMB_SUFFIX
        } else {
            ".jpg"
        }
    );
    let target = directory.join(&name);
    let partial = directory.join(format!(".partial-{}-{name}", uuid::Uuid::new_v4()));
    let fit = if crop {
        let tallest = (f64::from(THUMB_BOX) / THUMB_TALLEST_RATIO) as u32;
        format!("scale={THUMB_BOX}:{tallest}:force_original_aspect_ratio=increase,crop={THUMB_BOX}:{tallest}:(iw-{THUMB_BOX})/2:0")
    } else {
        format!("scale={THUMB_BOX}:{THUMB_BOX}:force_original_aspect_ratio=decrease")
    };
    let filter = with_orientation(kind, path, fit);
    let frames = if animated {
        ANIMATED_THUMB_MAX_FRAMES.to_string()
    } else {
        "1".into()
    };
    let mut arguments: Vec<&std::ffi::OsStr> = vec!["-v".as_ref(), "error".as_ref(), "-y".as_ref()];
    // Videos keep their recorded rotation; photos get the EXIF one from `filter`.
    if kind == MediaKind::Image {
        arguments.push("-noautorotate".as_ref());
    }
    // Seeking, even to zero, can discard the only frame of a JPEG.
    if kind == MediaKind::Video && probe.duration_ms.is_some_and(|duration| duration > 1000) {
        arguments.extend::<[&std::ffi::OsStr; 2]>(["-ss".as_ref(), "1".as_ref()]);
    }
    arguments.extend::<[&std::ffi::OsStr; 6]>([
        "-i".as_ref(),
        path.as_os_str(),
        "-vf".as_ref(),
        filter.as_ref(),
        "-frames:v".as_ref(),
        frames.as_ref(),
    ]);
    if animated {
        arguments.extend::<[&std::ffi::OsStr; 8]>([
            "-c:v".as_ref(),
            "libwebp_anim".as_ref(),
            "-quality".as_ref(),
            "70".as_ref(),
            "-loop".as_ref(),
            "0".as_ref(),
            "-f".as_ref(),
            "webp".as_ref(),
        ]);
    } else {
        arguments.extend::<[&std::ffi::OsStr; 4]>([
            "-q:v".as_ref(),
            "5".as_ref(),
            "-f".as_ref(),
            "mjpeg".as_ref(),
        ]);
    }
    arguments.push(partial.as_os_str());
    if let Err(error) = run("ffmpeg", &arguments).await {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }
    if tokio::fs::metadata(&partial).await?.len() == 0 {
        tokio::fs::remove_file(&partial).await?;
        return Err(Error::Storage("No thumbnail frame could be decoded".into()));
    }
    tokio::fs::rename(&partial, &target).await?;
    Ok(target)
}

/// 64-bit average hash of the displayed picture, as 16 hex digits.
pub async fn average_hash(path: &Path) -> Result<String> {
    let filter = with_orientation(
        MediaKind::Image,
        path,
        "scale=8:8:flags=area,format=gray".into(),
    );
    let pixels = run(
        "ffmpeg",
        &[
            "-v".as_ref(),
            "error".as_ref(),
            "-noautorotate".as_ref(),
            "-i".as_ref(),
            path.as_os_str(),
            "-vf".as_ref(),
            filter.as_ref(),
            "-frames:v".as_ref(),
            "1".as_ref(),
            "-f".as_ref(),
            "rawvideo".as_ref(),
            "-".as_ref(),
        ],
    )
    .await?;
    if pixels.len() != 64 {
        return Err(Error::Storage(format!(
            "unexpected hash sample of {} bytes",
            pixels.len()
        )));
    }
    Ok(hash_from_pixels(&pixels))
}

fn hash_from_pixels(pixels: &[u8]) -> String {
    let mean = pixels.iter().map(|value| f64::from(*value)).sum::<f64>() / pixels.len() as f64;
    pixels
        .chunks(4)
        .map(|nibble| {
            let value = nibble.iter().fold(0u8, |acc, pixel| {
                (acc << 1) | u8::from(f64::from(*pixel) > mean)
            });
            format!("{value:x}")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_sets_a_bit_for_each_pixel_brighter_than_the_mean() {
        let mut pixels = [0u8; 64];
        pixels[..4].copy_from_slice(&[255, 0, 255, 255]);
        pixels[60..].copy_from_slice(&[255; 4]);
        assert_eq!(hash_from_pixels(&pixels), "b00000000000000f");
    }

    #[test]
    fn kinds_follow_the_reference_extensions() {
        assert_eq!(detect_kind(Path::new("a/B.JPG")), Some(MediaKind::Image));
        assert_eq!(detect_kind(Path::new("clip.webm")), Some(MediaKind::Video));
        assert_eq!(detect_kind(Path::new("photo.dng")), None);
        assert!(is_strip(Some(100), Some(1200)));
        assert!(!is_strip(Some(500), Some(1000)));
        assert!(!is_strip(None, Some(1000)));
    }
}
