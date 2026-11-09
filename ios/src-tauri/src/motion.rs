//! Bounded GIF decoding and H.264 encoding on the blocking media worker.
use std::{
    fs::File,
    io::BufReader,
    path::Path,
    ptr::NonNull,
    time::{Duration, Instant},
};

use gooncave_core::media::{thumb_tallest, ANIMATED_THUMB_MAX_FRAMES, THUMB_BOX};
use image::{codecs::gif::GifDecoder, imageops, AnimationDecoder, ImageDecoder, RgbaImage};
use objc2::runtime::AnyObject;
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor, AVAssetWriterStatus,
    AVFileTypeMPEG4, AVMediaTypeVideo, AVVideoCodecKey, AVVideoCodecTypeH264, AVVideoHeightKey,
    AVVideoWidthKey,
};
use objc2_core_foundation::CFRetained;
use objc2_core_media::CMTime;
use objc2_core_video::{
    kCVPixelFormatType_32BGRA, CVPixelBuffer, CVPixelBufferCreate, CVPixelBufferGetBaseAddress,
    CVPixelBufferGetBytesPerRow, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};

const MAX_SECONDS: f64 = 8.0;

pub(super) fn encode(path: &Path, target: &Path, crop: bool) -> Result<(), String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut gif = GifDecoder::new(BufReader::new(file)).map_err(|error| error.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(128 * 1024 * 1024);
    gif.set_limits(limits).map_err(|error| error.to_string())?;
    let (width, height) = gif.dimensions();
    let (width, height) = if crop {
        (THUMB_BOX, thumb_tallest())
    } else {
        let scale = (f64::from(THUMB_BOX) / f64::from(width.max(height))).min(1.0);
        (
            (f64::from(width) * scale).round().max(1.0) as u32,
            (f64::from(height) * scale).round().max(1.0) as u32,
        )
    };
    let encoded_width = width.next_multiple_of(2);
    let encoded_height = height.next_multiple_of(2);
    let path = target.to_str().ok_or("Invalid thumbnail path")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));

    // SAFETY: The writer receives a new file URL and AVFoundation's H.264 settings.
    unsafe {
        let writer = AVAssetWriter::assetWriterWithURL_fileType_error(
            &url,
            AVFileTypeMPEG4.ok_or("MP4 is unavailable")?,
        )
        .map_err(|error| error.localizedDescription().to_string())?;
        let width_setting = NSNumber::numberWithUnsignedInt(encoded_width);
        let height_setting = NSNumber::numberWithUnsignedInt(encoded_height);
        let settings = NSDictionary::<NSString, AnyObject>::from_slices(
            &[
                AVVideoCodecKey.ok_or("Video codec key is unavailable")?,
                AVVideoWidthKey.ok_or("Video width key is unavailable")?,
                AVVideoHeightKey.ok_or("Video height key is unavailable")?,
            ],
            &[
                AVVideoCodecTypeH264.ok_or("H.264 is unavailable")?,
                &width_setting,
                &height_setting,
            ],
        );
        let input = AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(
            AVMediaTypeVideo.ok_or("Video encoding is unavailable")?,
            Some(&settings),
        );
        if !writer.canAddInput(&input) {
            return Err("Cannot add the thumbnail video track".into());
        }
        let adaptor = AVAssetWriterInputPixelBufferAdaptor::assetWriterInputPixelBufferAdaptorWithAssetWriterInput_sourcePixelBufferAttributes(&input, None);
        writer.addInput(&input);
        if !writer.startWriting() {
            return Err(writer_error(&writer));
        }
        writer.startSessionAtSourceTime(CMTime::with_seconds(0.0, 600));
        let result = (|| {
            let deadline = Instant::now() + Duration::from_secs(20);
            let mut time = 0.0;
            for frame in gif.into_frames().take(ANIMATED_THUMB_MAX_FRAMES as usize) {
                // Like FFmpeg on desktop, a damaged frame ends the clip but keeps the frames before it.
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(_) if time > 0.0 => break,
                    Err(error) => return Err(error.to_string()),
                };
                let (numerator, denominator) = frame.delay().numer_denom_ms();
                let delay = f64::from(numerator) / f64::from(denominator) / 1000.0;
                // Browsers and FFmpeg show a frame shorter than 20 ms for 100 ms.
                let delay = if delay < 0.02 { 0.1 } else { delay };
                let mut frame = frame.into_buffer();
                if crop {
                    let left = (frame.width() - width_for_strip(&frame)) / 2;
                    let span = width_for_strip(&frame);
                    let rows = frame.height().min(span * 2);
                    frame = imageops::crop_imm(&frame, left, 0, span, rows).to_image();
                }
                let frame = imageops::resize(&frame, width, height, imageops::FilterType::Triangle);
                let buffer = pixel_buffer(&frame, encoded_width, encoded_height)?;
                while !input.isReadyForMoreMediaData() {
                    if writer.status() != AVAssetWriterStatus::Writing || Instant::now() >= deadline
                    {
                        return Err(writer_error(&writer));
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
                if !adaptor.appendPixelBuffer_withPresentationTime(
                    &buffer,
                    CMTime::with_seconds(time, 600),
                ) {
                    return Err(writer_error(&writer));
                }
                time = (time + delay).min(MAX_SECONDS);
                if time >= MAX_SECONDS {
                    break;
                }
            }
            if time == 0.0 {
                return Err("No GIF frames could be decoded".into());
            }
            writer.endSessionAtSourceTime(CMTime::with_seconds(time, 600));
            input.markAsFinished();
            // The entire encode is already on a blocking worker.
            #[allow(deprecated)]
            if !writer.finishWriting() {
                return Err(writer_error(&writer));
            }
            Ok(())
        })();
        if result.is_err() && writer.status() == AVAssetWriterStatus::Writing {
            writer.cancelWriting();
        }
        result
    }
}

fn width_for_strip(frame: &RgbaImage) -> u32 {
    frame.width().min((frame.height() / 2).max(1))
}

fn writer_error(writer: &AVAssetWriter) -> String {
    // SAFETY: Reading the writer's current error is valid in every state.
    unsafe { writer.error() }
        .map(|error| error.localizedDescription().to_string())
        .unwrap_or_else(|| "The thumbnail video encoder stopped".into())
}

fn pixel_buffer(
    frame: &RgbaImage,
    width: u32,
    height: u32,
) -> Result<CFRetained<CVPixelBuffer>, String> {
    let mut raw = std::ptr::null_mut();
    // SAFETY: The out pointer is valid and the requested format has one packed BGRA plane.
    unsafe {
        if CVPixelBufferCreate(
            None,
            width as usize,
            height as usize,
            kCVPixelFormatType_32BGRA,
            None,
            NonNull::from(&mut raw),
        ) != 0
        {
            return Err("Cannot allocate the thumbnail video frame".into());
        }
        let buffer = CFRetained::from_raw(NonNull::new(raw).ok_or("No video frame buffer")?);
        let flags = CVPixelBufferLockFlags::empty();
        if CVPixelBufferLockBaseAddress(&buffer, flags) != 0 {
            return Err("Cannot lock the thumbnail video frame".into());
        }
        let stride = CVPixelBufferGetBytesPerRow(&buffer);
        let base = CVPixelBufferGetBaseAddress(&buffer).cast::<u8>();
        let valid = !base.is_null() && stride >= width as usize * 4;
        if valid {
            let bytes = std::slice::from_raw_parts_mut(base, stride * height as usize);
            bytes.fill(0);
            for (y, row) in frame.rows().enumerate() {
                for (x, pixel) in row.enumerate() {
                    let [r, g, b, a] = pixel.0;
                    let opaque = |value: u8| (u16::from(value) * u16::from(a) / 255) as u8;
                    let offset = y * stride + x * 4;
                    bytes[offset..offset + 4].copy_from_slice(&[
                        opaque(b),
                        opaque(g),
                        opaque(r),
                        255,
                    ]);
                }
            }
        }
        if CVPixelBufferUnlockBaseAddress(&buffer, flags) != 0 || !valid {
            return Err("Cannot finish the thumbnail video frame".into());
        }
        Ok(buffer)
    }
}
