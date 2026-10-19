//! Image attachment support and safe reading under `MAX_IMAGE_BYTES`.

use crate::agent::{FilesError, MAX_IMAGE_BYTES};
use std::io::Read;
use std::path::Path;

/// The image extensions the picker accepts — the SAME allowlist as the
/// frontend's `SUPPORTED_IMAGE_TYPES` (the MIMEs the vision APIs accept:
/// an SVG passes an `image/*` filter but fails at the provider, so the
/// allowlist is enforced here AND in the frontend).
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

/// Is the path's extension in the image allowlist (case-insensitive; a
/// path with no extension is `false`)?
pub fn is_supported_image_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_lowercase().as_str()))
}

/// Is a file of `len` bytes within the prompt path's 10 MiB cap
/// (`MAX_IMAGE_BYTES`, ADR 0008)? Factored out as a pure comparison so
/// the check is unit-testable without writing a 10 MiB file (the same
/// pattern as the clipboard path's `encoded_png_within_cap`).
pub fn image_within_cap(len: u64) -> bool {
    len <= MAX_IMAGE_BYTES
}

/// Read a picked image's bytes safely under `MAX_IMAGE_BYTES`.
///
/// Refuses non-regular files (FIFOs, device files, directories) safely
/// without blocking, respects symlinks to regular files, and enforces
/// an atomic read cap.
pub fn read_image_capped(path: &Path) -> Result<Option<Vec<u8>>, FilesError> {
    let md = std::fs::metadata(path).map_err(|e| FilesError::Io(e.to_string()))?;
    if !md.is_file() {
        return Ok(None);
    }
    if !image_within_cap(md.len()) {
        return Err(FilesError::ImageTooLarge {
            size: md.len(),
            max: MAX_IMAGE_BYTES,
        });
    }

    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)
            .map_err(|e| FilesError::Io(e.to_string()))?
    };
    #[cfg(not(unix))]
    let file = std::fs::File::open(path).map_err(|e| FilesError::Io(e.to_string()))?;

    let file_md = file.metadata().map_err(|e| FilesError::Io(e.to_string()))?;
    if !file_md.is_file() {
        return Ok(None);
    }

    let mut buf = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| FilesError::Io(e.to_string()))?;

    if buf.len() > MAX_IMAGE_BYTES as usize {
        return Err(FilesError::ImageTooLarge {
            size: md.len().max(buf.len() as u64),
            max: MAX_IMAGE_BYTES,
        });
    }

    Ok(Some(buf))
}
