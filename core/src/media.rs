use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde_json::Value;
use tokio::{io::AsyncWriteExt, process::Command};

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

/// Whether the bytes are an animated WebP, whatever the extension; FFmpeg's WebP decoder
/// cannot read those.
fn is_animated_webp(path: &Path) -> bool {
    let mut header = [0u8; 21];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && &header[..4] == b"RIFF"
        && &header[8..16] == b"WEBPVP8X"
        && header[20] & 0x02 != 0
}

fn first_frame_png(path: &Path) -> Result<Vec<u8>> {
    let unreadable = |error: image::ImageError| {
        Error::Storage(format!("cannot read the animated WebP: {error}"))
    };
    let picture = image::ImageReader::open(path)?
        .with_guessed_format()?
        .decode()
        .map_err(unreadable)?;
    let mut png = Vec::new();
    picture
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(unreadable)?;
    Ok(png)
}

/// What FFmpeg reads for a file: the file itself, or the first frame of an animated WebP
/// decoded here and piped in as PNG.
struct Input<'a> {
    path: &'a Path,
    frame: Option<Vec<u8>>,
}

impl<'a> Input<'a> {
    async fn open(path: &'a Path) -> Result<Self> {
        let frame = if is_animated_webp(path) {
            let owned = path.to_owned();
            Some(
                tokio::task::spawn_blocking(move || first_frame_png(&owned))
                    .await
                    .map_err(|error| Error::Storage(format!("WebP decoder stopped: {error}")))??,
            )
        } else {
            None
        };
        Ok(Self { path, frame })
    }

    fn arg(&self) -> &std::ffi::OsStr {
        match self.frame {
            Some(_) => "pipe:0".as_ref(),
            None => self.path.as_os_str(),
        }
    }
}

async fn run(program: &str, arguments: &[&std::ffi::OsStr], input: &Input<'_>) -> Result<Vec<u8>> {
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(if input.frame.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            Error::Storage(format!(
                "cannot start {program}: {error}. Install FFmpeg to read media files."
            ))
        })?;
    let stdin = child.stdin.take();
    let feed = async {
        if let (Some(mut stdin), Some(frame)) = (stdin, &input.frame) {
            stdin.write_all(frame).await?;
        }
        Ok::<_, std::io::Error>(())
    };
    let (fed, output) = tokio::time::timeout(TOOL_TIMEOUT, async {
        tokio::join!(feed, child.wait_with_output())
    })
    .await
    .map_err(|_| Error::Storage(format!("{program} timed out")))?;
    let output = output?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(Error::Storage(format!(
            "{program} failed: {}",
            message.lines().last().unwrap_or("no output")
        )));
    }
    // A tool that exits successfully may close stdin before reading the whole frame.
    match fed {
        Err(error) if error.kind() != std::io::ErrorKind::BrokenPipe => Err(error.into()),
        _ => Ok(output.stdout),
    }
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
    let input = Input::open(path).await?;
    let output = run(
        "ffprobe",
        &[
            "-v".as_ref(),
            "error".as_ref(),
            "-print_format".as_ref(),
            "json".as_ref(),
            "-show_streams".as_ref(),
            "-show_format".as_ref(),
            input.arg(),
        ],
        &input,
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
    let input = Input::open(path).await?;
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
        input.arg(),
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
    if let Err(error) = run("ffmpeg", &arguments, &input).await {
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

/// A still PNG for automatic tagging, bounded to 2048 pixels on each side.
pub(crate) async fn tagging_image(
    path: &Path,
    kind: MediaKind,
    duration_ms: Option<i64>,
) -> Result<Vec<u8>> {
    let input = Input::open(path).await?;
    let filter = with_orientation(kind, path,
        "scale=w='min(2048,iw)':h='min(2048,ih)':force_original_aspect_ratio=decrease:flags=lanczos,format=rgb24".into());
    let mut arguments: Vec<&std::ffi::OsStr> =
        vec!["-v".as_ref(), "error".as_ref(), "-noautorotate".as_ref()];
    // Seeking past the end of a clip shorter than a second yields no frame at all.
    if kind == MediaKind::Video && duration_ms.is_none_or(|duration| duration > 1000) {
        arguments.extend([std::ffi::OsStr::new("-ss"), std::ffi::OsStr::new("1")]);
    }
    arguments.extend([
        "-i".as_ref(),
        input.arg(),
        "-vf".as_ref(),
        filter.as_ref(),
        "-frames:v".as_ref(),
        "1".as_ref(),
        "-c:v".as_ref(),
        "png".as_ref(),
        "-f".as_ref(),
        "image2pipe".as_ref(),
        "-".as_ref(),
    ]);
    let bytes = run("ffmpeg", &arguments, &input).await?;
    if bytes.is_empty() || bytes.len() > crate::wd14_model::MAX_IMAGE_BYTES {
        return Err(Error::Storage(
            "Cannot prepare this file for automatic tagging. Existing tags were kept.".into(),
        ));
    }
    Ok(bytes)
}

pub(crate) async fn source_image(
    path: &Path,
    kind: MediaKind,
    duration_ms: Option<i64>,
) -> Result<Vec<u8>> {
    let input = Input::open(path).await?;
    let filter = with_orientation(
        kind,
        path,
        "scale=512:512:force_original_aspect_ratio=decrease,format=rgb24".into(),
    );
    let seek = if kind == MediaKind::Video {
        // Search different interior frames on retries; title screens often have no source match.
        let fraction = 0.1 + 0.8 * f64::from(uuid::Uuid::new_v4().as_bytes()[0]) / 255.0;
        duration_ms
            .filter(|duration| *duration > 0)
            .map(|duration| (duration as f64 / 1000.0 * fraction).to_string())
    } else {
        None
    };
    let mut arguments: Vec<&std::ffi::OsStr> =
        vec!["-v".as_ref(), "error".as_ref(), "-noautorotate".as_ref()];
    if let Some(seek) = &seek {
        arguments.push("-ss".as_ref());
        arguments.push(seek.as_ref());
    }
    arguments.extend([
        "-i".as_ref(),
        input.arg(),
        "-vf".as_ref(),
        filter.as_ref(),
        "-frames:v".as_ref(),
        "1".as_ref(),
        "-c:v".as_ref(),
        "png".as_ref(),
        "-f".as_ref(),
        "image2pipe".as_ref(),
        "-".as_ref(),
    ]);
    let bytes = run("ffmpeg", &arguments, &input).await?;
    if bytes.is_empty() || bytes.len() > 2 * 1024 * 1024 {
        return Err(Error::Storage(
            "Cannot prepare this file for image search. Try another file.".into(),
        ));
    }
    Ok(bytes)
}

/// `size`×`size` grayscale pixels of the displayed picture, or of the video frame at `seek` seconds.
pub(crate) async fn signature_frame(
    path: &Path,
    kind: MediaKind,
    size: u32,
    seek: Option<f64>,
) -> Result<Vec<u8>> {
    let input = Input::open(path).await?;
    let filter = with_orientation(
        kind,
        path,
        format!("scale={size}:{size}:flags=area,format=gray"),
    );
    let seek = seek.map(|seconds| format!("{seconds:.2}"));
    let mut arguments: Vec<&std::ffi::OsStr> =
        vec!["-v".as_ref(), "error".as_ref(), "-noautorotate".as_ref()];
    if let Some(seek) = &seek {
        arguments.extend([std::ffi::OsStr::new("-ss"), std::ffi::OsStr::new(seek)]);
    }
    arguments.extend([
        "-i".as_ref(),
        input.arg(),
        "-vf".as_ref(),
        filter.as_ref(),
        "-frames:v".as_ref(),
        "1".as_ref(),
        "-f".as_ref(),
        "rawvideo".as_ref(),
        "-".as_ref(),
    ]);
    let pixels = run("ffmpeg", &arguments, &input).await?;
    if pixels.len() != (size * size) as usize {
        return Err(Error::Storage(format!(
            "unexpected signature sample of {} bytes",
            pixels.len()
        )));
    }
    Ok(pixels)
}

/// 64-bit average hash of the displayed picture, as 16 hex digits.
pub async fn average_hash(path: &Path) -> Result<String> {
    let input = Input::open(path).await?;
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
            input.arg(),
            "-vf".as_ref(),
            filter.as_ref(),
            "-frames:v".as_ref(),
            "1".as_ref(),
            "-f".as_ref(),
            "rawvideo".as_ref(),
            "-".as_ref(),
        ],
        &input,
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

    #[tokio::test]
    async fn animated_webp_is_read_from_its_first_frame() {
        let directory = tempfile::TempDir::new().unwrap();
        let path = directory.path().join("loop.webp");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:size=120x80:rate=5:duration=1",
                "-vf",
                "drawbox=c=blue:t=fill:enable='gte(n,1)'",
            ])
            .args(["-c:v", "libwebp_anim", "-lossless", "1", "-loop", "0"])
            .arg(&path)
            .status()
            .expect("FFmpeg must be installed to run the media tests");
        assert!(status.success());
        assert!(is_animated_webp(&path));
        let misnamed = directory.path().join("loop.png");
        std::fs::copy(&path, &misnamed).unwrap();
        assert!(is_animated_webp(&misnamed));

        let probe = probe(&path, MediaKind::Image).await.unwrap();
        assert_eq!((probe.width, probe.height), (Some(120), Some(80)));
        let thumb = thumbnail(&path, MediaKind::Image, probe, directory.path(), "loop")
            .await
            .unwrap();
        assert!(std::fs::read(thumb).unwrap().starts_with(&[0xff, 0xd8]));
        assert_eq!(average_hash(&path).await.unwrap().len(), 16);
        let png = tagging_image(&path, MediaKind::Image, None).await.unwrap();
        let frame = image::load_from_memory(&png).unwrap().to_rgb8();
        let [red, green, blue] = frame.get_pixel(60, 40).0;
        assert!(
            red > 200 && green < 50 && blue < 50,
            "first frame is red, got {red},{green},{blue}"
        );
    }

    #[tokio::test]
    async fn a_video_shorter_than_the_seek_is_tagged_from_its_start() {
        let directory = tempfile::TempDir::new().unwrap();
        let path = directory.path().join("blink.mp4");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x64:rate=10",
                "-t",
                "0.5",
            ])
            .args(["-c:v", "mpeg4"])
            .arg(&path)
            .status()
            .expect("FFmpeg must be installed to run the media tests");
        assert!(status.success());

        let png = tagging_image(&path, MediaKind::Video, Some(500))
            .await
            .unwrap();
        assert!(png.starts_with(b"\x89PNG"));
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
