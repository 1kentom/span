use crate::{io_error, CoreError, CoreWorkspace, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{fs::File, io::Read};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RasterImage {
    pub mime: String,
    pub data: Vec<u8>,
}

impl CoreWorkspace {
    /// Agent paths are untrusted. Check the originating workspace before resolving the path.
    pub fn read_agent_image(
        &self,
        path: &str,
        expected_workspace_root: &str,
    ) -> Result<RasterImage> {
        if self.workspace().root != expected_workspace_root {
            return Err(CoreError::InvalidEdit(
                "The workspace changed before the generated image could be read".into(),
            ));
        }
        self.read_image(path, 8 * 1024 * 1024)
    }

    /// Local Markdown raster images only. Workspace canonicalization blocks escaping links.
    pub fn read_image(&self, path: &str, max_bytes: usize) -> Result<RasterImage> {
        let path = self.resolve(path)?;
        let limit = max_bytes.min(8 * 1024 * 1024);
        let file = File::open(&path).map_err(|error| io_error("Open local image", &path, error))?;
        let mut data = Vec::new();
        file.take((limit + 1) as u64)
            .read_to_end(&mut data)
            .map_err(|error| io_error("Read local image", &path, error))?;
        if data.len() > limit {
            return Err(CoreError::InvalidEdit(format!(
                "Local image exceeds {limit} byte limit"
            )));
        }
        let mime = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if data.starts_with(b"\xff\xd8\xff") {
            "image/jpeg"
        } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
            "image/gif"
        } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
            "image/webp"
        } else {
            return Err(CoreError::InvalidEdit(
                "Local preview supports PNG, JPEG, GIF and WebP images".into(),
            ));
        };
        validate_raster_dimensions(&data, mime)?;
        Ok(RasterImage {
            mime: mime.into(),
            data,
        })
    }
}

const MAX_IMAGE_EDGE: u32 = 16_384;
const MAX_IMAGE_PIXELS: u64 = 64 * 1024 * 1024;

fn malformed(format: &str) -> CoreError {
    CoreError::InvalidEdit(format!("Malformed or truncated {format} image header"))
}
fn dimensions(width: u32, height: u32) -> Result<(u32, u32)> {
    if width == 0
        || height == 0
        || width > MAX_IMAGE_EDGE
        || height > MAX_IMAGE_EDGE
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err(CoreError::InvalidEdit(
            "Local image dimensions exceed the preview limit (16,384 px per side, 64 megapixels)"
                .into(),
        ));
    }
    Ok((width, height))
}
fn bytes<const N: usize>(data: &[u8], offset: usize, format: &str) -> Result<[u8; N]> {
    data.get(offset..offset.saturating_add(N))
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| malformed(format))
}
fn le24(data: &[u8], offset: usize) -> Result<u32> {
    let value = bytes::<3>(data, offset, "WebP")?;
    Ok(u32::from(value[0]) | u32::from(value[1]) << 8 | u32::from(value[2]) << 16)
}
fn validate_raster_dimensions(data: &[u8], mime: &str) -> Result<()> {
    match mime {
        "image/png" => {
            if data.len() < 33 || data.get(8..16) != Some(&b"\0\0\0\rIHDR"[..]) {
                return Err(malformed("PNG"));
            }
            dimensions(
                u32::from_be_bytes(bytes(data, 16, "PNG")?),
                u32::from_be_bytes(bytes(data, 20, "PNG")?),
            )?;
        }
        "image/gif" => validate_gif(data)?,
        "image/jpeg" => validate_jpeg(data)?,
        "image/webp" => validate_webp(data)?,
        _ => return Err(malformed("raster")),
    }
    Ok(())
}
fn skip_gif_blocks(data: &[u8], mut offset: usize) -> Result<usize> {
    loop {
        let size = usize::from(*data.get(offset).ok_or_else(|| malformed("GIF"))?);
        offset = offset
            .checked_add(size + 1)
            .ok_or_else(|| malformed("GIF"))?;
        if offset > data.len() {
            return Err(malformed("GIF"));
        }
        if size == 0 {
            return Ok(offset);
        }
    }
}
fn validate_gif(data: &[u8]) -> Result<()> {
    let width = u32::from(u16::from_le_bytes(bytes(data, 6, "GIF")?));
    let height = u32::from(u16::from_le_bytes(bytes(data, 8, "GIF")?));
    dimensions(width, height)?;
    let packed = *data.get(10).ok_or_else(|| malformed("GIF"))?;
    let mut offset = 13
        + if packed & 0x80 != 0 {
            3 * (1_usize << ((packed & 7) + 1))
        } else {
            0
        };
    let mut total_pixels = 0_u64;
    loop {
        match data.get(offset).copied().ok_or_else(|| malformed("GIF"))? {
            0x3b if total_pixels > 0 => return Ok(()),
            0x21 => {
                data.get(offset + 1).ok_or_else(|| malformed("GIF"))?;
                offset = skip_gif_blocks(data, offset + 2)?;
            }
            0x2c => {
                let left = u32::from(u16::from_le_bytes(bytes(data, offset + 1, "GIF")?));
                let top = u32::from(u16::from_le_bytes(bytes(data, offset + 3, "GIF")?));
                let frame_width = u32::from(u16::from_le_bytes(bytes(data, offset + 5, "GIF")?));
                let frame_height = u32::from(u16::from_le_bytes(bytes(data, offset + 7, "GIF")?));
                dimensions(frame_width, frame_height)?;
                if left + frame_width > width || top + frame_height > height {
                    return Err(malformed("GIF"));
                }
                total_pixels += u64::from(frame_width) * u64::from(frame_height);
                if total_pixels > MAX_IMAGE_PIXELS {
                    return Err(CoreError::InvalidEdit(
                        "Animated GIF exceeds the 64 megapixel preview budget".into(),
                    ));
                }
                let packed = *data.get(offset + 9).ok_or_else(|| malformed("GIF"))?;
                offset += 10
                    + if packed & 0x80 != 0 {
                        3 * (1_usize << ((packed & 7) + 1))
                    } else {
                        0
                    };
                if !data
                    .get(offset)
                    .is_some_and(|code_size| (2..=8).contains(code_size))
                {
                    return Err(malformed("GIF"));
                }
                offset = skip_gif_blocks(data, offset + 1)?;
            }
            _ => return Err(malformed("GIF")),
        }
    }
}
fn validate_jpeg(data: &[u8]) -> Result<()> {
    let mut offset = 2;
    let mut found_dimensions = false;
    while offset < data.len() {
        if data[offset] != 0xff {
            return Err(malformed("JPEG"));
        }
        while data.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let marker = *data.get(offset).ok_or_else(|| malformed("JPEG"))?;
        offset += 1;
        if marker == 0xd9 {
            return Err(malformed("JPEG"));
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        let length = usize::from(u16::from_be_bytes(bytes(data, offset, "JPEG")?));
        if length < 2 {
            return Err(malformed("JPEG"));
        }
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= data.len())
            .ok_or_else(|| malformed("JPEG"))?;
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            if length < 8 {
                return Err(malformed("JPEG"));
            }
            let height = u32::from(u16::from_be_bytes(bytes(data, offset + 3, "JPEG")?));
            let width = u32::from(u16::from_be_bytes(bytes(data, offset + 5, "JPEG")?));
            let components = usize::from(*data.get(offset + 7).ok_or_else(|| malformed("JPEG"))?);
            if components == 0 || length != 8 + 3 * components {
                return Err(malformed("JPEG"));
            }
            dimensions(width, height)?;
            found_dimensions = true;
        }
        if marker == 0xda {
            if !found_dimensions || !data[end..].windows(2).any(|pair| pair == [0xff, 0xd9]) {
                return Err(malformed("JPEG"));
            }
            return Ok(());
        }
        offset = end;
    }
    Err(malformed("JPEG"))
}
fn webp_frame_dimensions(kind: &[u8], payload: &[u8]) -> Result<Option<(u32, u32)>> {
    let result = match kind {
        b"VP8 " => {
            if payload.len() < 10
                || payload[0] & 1 != 0
                || payload.get(3..6) != Some(&[0x9d, 0x01, 0x2a])
            {
                return Err(malformed("WebP"));
            }
            (
                u32::from(u16::from_le_bytes(bytes(payload, 6, "WebP")?) & 0x3fff),
                u32::from(u16::from_le_bytes(bytes(payload, 8, "WebP")?) & 0x3fff),
            )
        }
        b"VP8L" => {
            if payload.first() != Some(&0x2f) {
                return Err(malformed("WebP"));
            }
            let bits = u32::from_le_bytes(bytes(payload, 1, "WebP")?);
            if bits >> 29 != 0 {
                return Err(malformed("WebP"));
            }
            ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
        }
        _ => return Ok(None),
    };
    Ok(Some(dimensions(result.0, result.1)?))
}
fn webp_chunk(data: &[u8], offset: usize) -> Result<(&[u8], &[u8], usize)> {
    let kind = data
        .get(offset..offset.saturating_add(4))
        .ok_or_else(|| malformed("WebP"))?;
    let length = u32::from_le_bytes(bytes(data, offset + 4, "WebP")?) as usize;
    let start = offset.checked_add(8).ok_or_else(|| malformed("WebP"))?;
    let end = start
        .checked_add(length)
        .filter(|end| *end <= data.len())
        .ok_or_else(|| malformed("WebP"))?;
    let next = end
        .checked_add(length & 1)
        .filter(|end| *end <= data.len())
        .ok_or_else(|| malformed("WebP"))?;
    Ok((kind, &data[start..end], next))
}
fn validate_webp(data: &[u8]) -> Result<()> {
    let declared = u32::from_le_bytes(bytes(data, 4, "WebP")?) as usize;
    if declared.checked_add(8) != Some(data.len()) {
        return Err(malformed("WebP"));
    }
    let mut offset = 12;
    let mut canvas = None;
    let mut found_image = false;
    let mut animated_pixels = 0_u64;
    while offset < data.len() {
        let (kind, payload, next) = webp_chunk(data, offset)?;
        if kind == b"VP8X" {
            if payload.len() != 10 {
                return Err(malformed("WebP"));
            }
            canvas = Some(dimensions(le24(payload, 4)? + 1, le24(payload, 7)? + 1)?);
        } else if kind == b"ANMF" {
            if payload.len() < 16 {
                return Err(malformed("WebP"));
            }
            let frame = dimensions(le24(payload, 6)? + 1, le24(payload, 9)? + 1)?;
            let (canvas_width, canvas_height) = canvas.ok_or_else(|| malformed("WebP"))?;
            if le24(payload, 0)? * 2 + frame.0 > canvas_width
                || le24(payload, 3)? * 2 + frame.1 > canvas_height
            {
                return Err(malformed("WebP"));
            }
            animated_pixels += u64::from(frame.0) * u64::from(frame.1);
            if animated_pixels > MAX_IMAGE_PIXELS {
                return Err(CoreError::InvalidEdit(
                    "Animated WebP exceeds the 64 megapixel preview budget".into(),
                ));
            }
            let mut inner_offset = 16;
            let mut found_frame = false;
            while inner_offset < payload.len() {
                let (inner_kind, inner_payload, inner_next) = webp_chunk(payload, inner_offset)?;
                if let Some(actual) = webp_frame_dimensions(inner_kind, inner_payload)? {
                    if actual != frame {
                        return Err(malformed("WebP"));
                    }
                    found_frame = true;
                }
                inner_offset = inner_next;
            }
            if !found_frame {
                return Err(malformed("WebP"));
            }
            found_image = true;
        } else if let Some(frame) = webp_frame_dimensions(kind, payload)? {
            if canvas.is_some_and(|(width, height)| frame.0 > width || frame.1 > height) {
                return Err(malformed("WebP"));
            }
            found_image = true;
        }
        offset = next;
    }
    if !found_image {
        return Err(malformed("WebP"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn read_fixture(data: &[u8]) -> Result<RasterImage> {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("fixture.image"), data).unwrap();
        CoreWorkspace::open(directory.path())
            .unwrap()
            .read_image("fixture.image", 8 * 1024 * 1024)
    }
    #[test]
    fn agent_images_require_the_exact_originating_workspace_and_stay_inside_it() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("image.png"), TINY_PNG).unwrap();
        fs::write(outside.path().join("outside.png"), TINY_PNG).unwrap();
        let workspace = CoreWorkspace::open(directory.path()).unwrap();
        let root = workspace.workspace().root;
        for path in [
            "image.png".to_owned(),
            directory.path().join("image.png").display().to_string(),
        ] {
            assert_eq!(
                workspace.read_agent_image(&path, &root).unwrap().data,
                TINY_PNG
            );
        }
        assert!(workspace
            .read_agent_image("image.png", "stale workspace")
            .unwrap_err()
            .to_string()
            .contains("workspace changed"));
        assert!(workspace
            .read_agent_image(
                &outside.path().join("outside.png").display().to_string(),
                &root
            )
            .is_err());
        assert!(workspace.read_agent_image("../outside.png", &root).is_err());
        fs::write(directory.path().join("script.svg"), b"<svg/>").unwrap();
        assert!(workspace.read_agent_image("script.svg", &root).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn agent_image_symlinks_cannot_escape_the_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.png"), TINY_PNG).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("outside.png"),
            directory.path().join("linked.png"),
        )
        .unwrap();
        let workspace = CoreWorkspace::open(directory.path()).unwrap();
        assert!(workspace
            .read_agent_image("linked.png", &workspace.workspace().root)
            .is_err());
    }

    #[test]
    fn compressed_oversized_png_is_rejected_before_browser_decode() {
        let mut image = TINY_PNG.to_vec();
        image[16..20].copy_from_slice(&100_000_u32.to_be_bytes());
        image[20..24].copy_from_slice(&100_000_u32.to_be_bytes());
        assert!(read_fixture(&image).is_err());
    }

    #[test]
    fn valid_tiny_images_in_all_four_formats_remain_available() {
        for (data, mime) in [
            (TINY_PNG, "image/png"),
            (TINY_GIF, "image/gif"),
            (TINY_JPEG, "image/jpeg"),
            (TINY_WEBP, "image/webp"),
        ] {
            let image = read_fixture(data).unwrap();
            assert_eq!(image.mime, mime);
            assert_eq!(image.data, data);
        }
    }
    #[test]
    fn dimensions_are_capped_for_gif_jpeg_and_webp_before_returning_bytes() {
        let mut gif = TINY_GIF.to_vec();
        gif[6..8].copy_from_slice(&20_000_u16.to_le_bytes());
        assert!(read_fixture(&gif)
            .unwrap_err()
            .to_string()
            .contains("dimensions"));
        let mut jpeg = TINY_JPEG.to_vec();
        let sof = jpeg
            .windows(2)
            .position(|pair| pair == [0xff, 0xc0])
            .unwrap();
        jpeg[sof + 5..sof + 7].copy_from_slice(&20_000_u16.to_be_bytes());
        assert!(read_fixture(&jpeg)
            .unwrap_err()
            .to_string()
            .contains("dimensions"));
        let mut webp = TINY_WEBP.to_vec();
        assert_eq!(&webp[12..16], b"VP8 ");
        webp[26..28].copy_from_slice(&10_000_u16.to_le_bytes());
        webp[28..30].copy_from_slice(&10_000_u16.to_le_bytes());
        assert!(read_fixture(&webp)
            .unwrap_err()
            .to_string()
            .contains("dimensions"));
    }
    #[test]
    fn pixel_limit_also_applies_when_each_png_side_is_within_edge_limit() {
        let mut image = TINY_PNG.to_vec();
        image[16..20].copy_from_slice(&9_000_u32.to_be_bytes());
        image[20..24].copy_from_slice(&9_000_u32.to_be_bytes());
        assert!(read_fixture(&image)
            .unwrap_err()
            .to_string()
            .contains("dimensions"));
        assert!(dimensions(16_384, 1).is_ok());
        assert!(dimensions(0, 1).is_err());
    }
    #[test]
    fn truncated_and_invalid_jpeg_webp_headers_return_contextual_errors() {
        for (data, mime, format) in [
            (TINY_JPEG, "image/jpeg", "JPEG"),
            (TINY_WEBP, "image/webp", "WebP"),
        ] {
            for end in 0..data.len() {
                let error = validate_raster_dimensions(&data[..end], mime).unwrap_err();
                assert!(error.to_string().contains(format));
            }
        }
        let mut jpeg = TINY_JPEG.to_vec();
        jpeg[4..6].copy_from_slice(&u16::MAX.to_be_bytes());
        assert!(validate_raster_dimensions(&jpeg, "image/jpeg")
            .unwrap_err()
            .to_string()
            .contains("JPEG"));
        let mut webp = TINY_WEBP.to_vec();
        webp[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(validate_raster_dimensions(&webp, "image/webp")
            .unwrap_err()
            .to_string()
            .contains("WebP"));
    }
    #[test]
    fn extended_and_lossless_webp_dimensions_are_checked() {
        let mut extended = b"RIFF".to_vec();
        extended.extend_from_slice(&22_u32.to_le_bytes());
        extended.extend_from_slice(b"WEBPVP8X");
        extended.extend_from_slice(&10_u32.to_le_bytes());
        extended.extend_from_slice(&[0, 0, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0]);
        assert!(validate_raster_dimensions(&extended, "image/webp")
            .unwrap_err()
            .to_string()
            .contains("dimensions"));
        let packed = 9_999_u32 | (9_999_u32 << 14);
        let mut lossless = vec![0x2f];
        lossless.extend_from_slice(&packed.to_le_bytes());
        assert!(webp_frame_dimensions(b"VP8L", &lossless)
            .unwrap_err()
            .to_string()
            .contains("dimensions"));
    }
    const TINY_PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2,
        0, 0, 0, 144, 119, 83, 222, 0, 0, 0, 12, 73, 68, 65, 84, 120, 218, 99, 96, 96, 96, 0, 0, 0,
        4, 0, 1, 200, 234, 235, 249, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    const TINY_GIF: &[u8] = &[
        71, 73, 70, 56, 55, 97, 1, 0, 1, 0, 129, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 44, 0,
        0, 0, 0, 1, 0, 1, 0, 0, 8, 4, 0, 1, 4, 4, 0, 59,
    ];
    const TINY_JPEG: &[u8] = &[
        255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 219, 0, 67,
        0, 8, 6, 6, 7, 6, 5, 8, 7, 7, 7, 9, 9, 8, 10, 12, 20, 13, 12, 11, 11, 12, 25, 18, 19, 15,
        20, 29, 26, 31, 30, 29, 26, 28, 28, 32, 36, 46, 39, 32, 34, 44, 35, 28, 28, 40, 55, 41, 44,
        48, 49, 52, 52, 52, 31, 39, 57, 61, 56, 50, 60, 46, 51, 52, 50, 255, 219, 0, 67, 1, 9, 9,
        9, 12, 11, 12, 24, 13, 13, 24, 50, 33, 28, 33, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50,
        50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50,
        50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 255, 192, 0, 17, 8, 0, 1,
        0, 1, 3, 1, 34, 0, 2, 17, 1, 3, 17, 1, 255, 196, 0, 21, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 8, 255, 196, 0, 20, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 255, 196, 0, 20, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 196, 0, 20,
        17, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 218, 0, 12, 3, 1, 0, 2, 17, 3,
        17, 0, 63, 0, 159, 192, 7, 255, 217,
    ];
    const TINY_WEBP: &[u8] = &[
        82, 73, 70, 70, 36, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32, 24, 0, 0, 0, 48, 1, 0, 157, 1,
        42, 1, 0, 1, 0, 1, 64, 38, 37, 164, 0, 3, 112, 0, 254, 253, 54, 104, 0,
    ];
}
