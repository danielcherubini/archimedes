use super::support::tmp_dir;
use crate::agent::{FilesError, MAX_IMAGE_BYTES};
use crate::commands::files::{image_within_cap, is_supported_image_path, read_file_bytes};

#[test]
fn is_supported_image_path_accepts_the_allowlist_case_insensitively() {
    for ext in ["png", "jpg", "jpeg", "gif", "webp", "PNG", "Jpg"] {
        assert!(
            is_supported_image_path(&format!("/home/u/pics/a.{ext}")),
            "{ext} should be accepted"
        );
    }
}

#[test]
fn is_supported_image_path_rejects_non_images_and_extensionless_paths() {
    for path in [
        "/home/u/docs/notes.txt",
        "/home/u/docs/diagram.svg",
        "/home/u/pics/noext",
        "/home/u/pics",
    ] {
        assert!(!is_supported_image_path(path), "{path} should be rejected");
    }
}

#[test]
fn image_within_cap_bounded_by_max_image_bytes() {
    assert!(image_within_cap(0));
    assert!(image_within_cap(MAX_IMAGE_BYTES));
    assert!(!image_within_cap(MAX_IMAGE_BYTES + 1));
}

#[tokio::test]
async fn read_file_bytes_returns_the_file_content_for_a_picked_image() {
    let dir = std::env::temp_dir().join(format!("files-cmd-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("shot.png");
    let bytes: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 1, 2, 3];
    std::fs::write(&path, &bytes).unwrap();
    let result = read_file_bytes(path.to_string_lossy().into()).await;
    assert_eq!(result, Ok(Some(bytes)));
}

#[tokio::test]
async fn read_file_bytes_returns_none_for_a_non_image_extension() {
    let dir = std::env::temp_dir().join(format!("files-cmd-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("notes.txt");
    std::fs::write(&path, b"hello").unwrap();
    let result = read_file_bytes(path.to_string_lossy().into()).await;
    assert_eq!(result, Ok(None));
}

#[tokio::test]
async fn read_file_bytes_errors_when_the_file_cannot_be_read() {
    // A supported extension but a missing file: the read fails (the
    // dialog selected a path that is gone by the time we read it —
    // e.g. the user deleted it).
    let result = read_file_bytes("/no/such/dir/shot.png".to_string()).await;
    let err = result.expect_err("a missing file is an error");
    assert!(matches!(err, FilesError::Io(_)));
}

#[tokio::test]
async fn read_file_bytes_succeeds_for_symlinked_image() {
    let dir = tmp_dir("symlink-image");
    let target = dir.join("real.png");
    let bytes: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 4, 5, 6];
    std::fs::write(&target, &bytes).unwrap();
    let symlink_path = dir.join("link.png");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &symlink_path).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&target, &symlink_path).unwrap();

    let result = read_file_bytes(symlink_path.to_string_lossy().into()).await;
    assert_eq!(result, Ok(Some(bytes)));
}

#[tokio::test]
async fn read_file_bytes_errors_when_exceeding_cap() {
    let dir = tmp_dir("oversized-image");
    let path = dir.join("huge.png");
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(MAX_IMAGE_BYTES + 1).unwrap();

    let result = read_file_bytes(path.to_string_lossy().into()).await;
    let err = result.expect_err("oversized image should error");
    assert_eq!(
        err,
        FilesError::ImageTooLarge {
            size: MAX_IMAGE_BYTES + 1,
            max: MAX_IMAGE_BYTES,
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn read_file_bytes_does_not_block_on_fifo() {
    let dir = tmp_dir("fifo-image");
    let fifo_path = dir.join("stream.png");
    let c_path = std::ffi::CString::new(fifo_path.to_str().unwrap()).unwrap();
    let res = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    assert_eq!(res, 0, "mkfifo succeeds");

    let res = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        read_file_bytes(fifo_path.to_string_lossy().into()),
    )
    .await;

    let res = res.expect("must not block on FIFO");
    assert_eq!(res, Ok(None));
}
