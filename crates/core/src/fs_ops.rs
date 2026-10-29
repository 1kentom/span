//! Explicit user file operations. Agent writes continue to use reviewed buffer proposals.
use crate::{
    io_error, BufferSnapshot, CancellationToken, CoreError, CoreWorkspace, FileEntry, Result,
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static COPY_ID: AtomicU64 = AtomicU64::new(1);
const MAX_COPY_ENTRIES: usize = 10_000;
const MAX_COPY_BYTES: u64 = 64 * 1024 * 1024;

impl CoreWorkspace {
    pub fn new_file(&mut self, path: &str) -> Result<BufferSnapshot> {
        let resolved = self.operation_path(path)?;
        let relative = self.relative(&resolved)?;
        if self.buffers.contains_key(&relative) {
            return Err(CoreError::InvalidEdit(format!(
                "Close the existing buffer before creating {relative}"
            )));
        }
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&resolved)
            .map_err(|error| io_error("Create file", &resolved, error))?;
        file.sync_all()
            .map_err(|error| io_error("Flush new file", &resolved, error))?;
        self.open_buffer(&relative)
    }

    pub fn new_directory(&mut self, path: &str) -> Result<FileEntry> {
        let resolved = self.operation_path(path)?;
        fs::create_dir(&resolved).map_err(|error| io_error("Create folder", &resolved, error))?;
        self.operation_entry(&resolved)
    }

    pub fn rename_path(&mut self, from: &str, to: &str) -> Result<FileEntry> {
        let source = self.existing_operation_path(from)?;
        let destination = self.operation_path(to)?;
        if source == destination {
            return self.operation_entry(&source);
        }
        self.ensure_operation_idle(&source)?;
        self.ensure_operation_idle(&destination)?;
        if destination.starts_with(&source) {
            return Err(CoreError::InvalidEdit(
                "A folder cannot be moved inside itself".into(),
            ));
        }
        let source_relative = self.relative(&source)?;
        let destination_relative = self.relative(&destination)?;
        let mut repaths = Vec::new();
        for (path, buffer) in &self.buffers {
            if let Ok(suffix) = Path::new(path).strip_prefix(&source_relative) {
                let revision = buffer
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| CoreError::InvalidEdit("Buffer revision exhausted".into()))?;
                // `join("")` would append a trailing separator to a renamed file.
                let new_path = if suffix.as_os_str().is_empty() {
                    destination_relative.clone()
                } else {
                    Path::new(&destination_relative)
                        .join(suffix)
                        .to_string_lossy()
                        .replace('\\', "/")
                };
                if self.buffers.contains_key(&new_path) {
                    return Err(CoreError::InvalidEdit(format!(
                        "A buffer is already open at {new_path}"
                    )));
                }
                repaths.push((path.clone(), new_path, revision));
            }
        }
        rename_no_replace(&source, &destination)
            .map_err(|error| io_error("Rename without overwriting", &destination, error))?;
        for (old, new, revision) in repaths {
            if let Some(mut buffer) = self.buffers.remove(&old) {
                buffer.revision = revision;
                buffer.saved_revision = revision;
                self.buffers.insert(new, buffer);
            }
        }
        self.operation_entry(&destination)
    }

    pub fn duplicate_path(&mut self, from: &str, to: &str) -> Result<FileEntry> {
        self.duplicate_path_cancellable(from, to, &CancellationToken::default())
    }

    pub fn duplicate_path_cancellable(
        &mut self,
        from: &str,
        to: &str,
        cancellation: &CancellationToken,
    ) -> Result<FileEntry> {
        let source = self.existing_operation_path(from)?;
        let destination = self.operation_path(to)?;
        self.ensure_operation_idle(&source)?;
        self.ensure_operation_idle(&destination)?;
        if destination.starts_with(&source) {
            return Err(CoreError::InvalidEdit(
                "A folder cannot be duplicated inside itself".into(),
            ));
        }
        if destination.symlink_metadata().is_ok() {
            return Err(io_error(
                "Duplicate without overwriting",
                &destination,
                std::io::Error::from(std::io::ErrorKind::AlreadyExists),
            ));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| CoreError::OutsideWorkspace(to.into()))?;
        let staging = parent.join(format!(
            ".span-copy-{}-{}",
            std::process::id(),
            COPY_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let is_directory = source.is_dir();
        let mut budget = CopyBudget {
            entries: 0,
            bytes: 0,
            cancellation,
            owns_staging: false,
        };
        let result = (|| {
            self.copy_entry(&source, &staging, &mut budget, 0)?;
            rename_no_replace(&staging, &destination).map_err(|error| {
                io_error("Publish duplicate without overwriting", &destination, error)
            })?;
            self.operation_entry(&destination)
        })();
        if result.is_err() && budget.owns_staging {
            // Only the operation's newly created staging entry is eligible for cleanup.
            if is_directory {
                let _ = fs::remove_dir_all(&staging);
            } else {
                let _ = fs::remove_file(&staging);
            }
        }
        result
    }

    /// Called only after the UI's explicit Move to Trash confirmation.
    pub fn trash_path(&mut self, path: &str) -> Result<Vec<String>> {
        self.trash_path_with(path, |resolved| {
            trash::delete(resolved).map_err(|error| {
                CoreError::InvalidEdit(format!(
                    "Move {} to system Trash: {error}",
                    resolved.display()
                ))
            })
        })
    }

    fn trash_path_with(
        &mut self,
        path: &str,
        trash: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<Vec<String>> {
        let resolved = self.existing_operation_path(path)?;
        self.ensure_operation_idle(&resolved)?;
        let relative = self.relative(&resolved)?;
        let removed: Vec<String> = self
            .buffers
            .keys()
            .filter(|path| Path::new(path).starts_with(&relative))
            .cloned()
            .collect();
        trash(&resolved)?;
        for path in &removed {
            self.buffers.remove(path);
        }
        Ok(removed)
    }

    fn operation_path(&self, path: &str) -> Result<PathBuf> {
        let resolved = self.resolve(path)?;
        if resolved == self.root {
            return Err(CoreError::InvalidEdit(
                "The workspace root cannot be changed by a file operation".into(),
            ));
        }
        let requested = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            self.root.join(path)
        };
        // Inspect the original final component so a clicked link never mutates its resolved target.
        if requested
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(CoreError::InvalidEdit(
                "File operations on symbolic links are not supported".into(),
            ));
        }
        Ok(resolved)
    }
    fn existing_operation_path(&self, path: &str) -> Result<PathBuf> {
        let resolved = self.operation_path(path)?;
        fs::metadata(&resolved)
            .map_err(|error| io_error("Inspect file operation source", &resolved, error))?;
        Ok(resolved)
    }
    fn ensure_operation_idle(&self, path: &Path) -> Result<()> {
        let relative = self.relative(path)?;
        for (path, buffer) in &self.buffers {
            if Path::new(path).starts_with(&relative)
                && (buffer.revision != buffer.saved_revision || buffer.disk_signature.is_none())
            {
                return Err(CoreError::InvalidEdit(format!(
                    "Save or discard unsaved changes in {path} before changing its path"
                )));
            }
        }
        if self
            .proposals
            .values()
            .any(|proposal| Path::new(&proposal.path).starts_with(&relative))
        {
            return Err(CoreError::InvalidEdit(
                "Resolve pending agent edits before changing this path".into(),
            ));
        }
        Ok(())
    }
    fn operation_entry(&self, path: &Path) -> Result<FileEntry> {
        let metadata =
            fs::metadata(path).map_err(|error| io_error("Inspect changed path", path, error))?;
        let name = path
            .file_name()
            .ok_or_else(|| CoreError::InvalidEdit("Missing file name".into()))?
            .to_string_lossy()
            .into_owned();
        let ignored = path.parent().is_some_and(|parent| {
            !span_file_index::unignored_children(&self.root, parent).contains(path)
        });
        Ok(FileEntry {
            path: self.relative(path)?,
            name,
            is_dir: metadata.is_dir(),
            ignored,
            background_excluded: span_file_index::background_excluded(
                path,
                metadata.is_dir(),
                ignored,
            ),
        })
    }
    fn copy_entry(
        &self,
        source: &Path,
        destination: &Path,
        budget: &mut CopyBudget<'_>,
        depth: usize,
    ) -> Result<()> {
        budget.check()?;
        if depth > 64 {
            return Err(CoreError::InvalidEdit(
                "Duplicate exceeds the 64 level folder limit".into(),
            ));
        }
        budget.entries += 1;
        if budget.entries > MAX_COPY_ENTRIES {
            return Err(CoreError::InvalidEdit(
                "Duplicate exceeds the 10,000 entry limit".into(),
            ));
        }
        let metadata = source
            .symlink_metadata()
            .map_err(|error| io_error("Inspect duplicate source", source, error))?;
        if metadata.file_type().is_symlink() {
            return Err(CoreError::InvalidEdit(format!(
                "Duplicate does not follow symbolic links: {}",
                source.display()
            )));
        }
        self.resolve(&source.to_string_lossy())?;
        if metadata.is_dir() {
            fs::create_dir(destination)
                .map_err(|error| io_error("Create duplicate folder", destination, error))?;
            if budget.entries == 1 {
                budget.owns_staging = true;
            }
            for entry in fs::read_dir(source)
                .map_err(|error| io_error("Read duplicate folder", source, error))?
            {
                let entry =
                    entry.map_err(|error| io_error("Read duplicate entry", source, error))?;
                self.copy_entry(
                    &entry.path(),
                    &destination.join(entry.file_name()),
                    budget,
                    depth + 1,
                )?;
            }
            fs::set_permissions(destination, metadata.permissions())
                .map_err(|error| io_error("Preserve folder permissions", destination, error))?;
        } else if metadata.is_file() {
            let mut input = open_copy_source(source)
                .map_err(|error| io_error("Read duplicate source", source, error))?;
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(destination)
                .map_err(|error| io_error("Create duplicate file", destination, error))?;
            if budget.entries == 1 {
                budget.owns_staging = true;
            }
            let mut chunk = [0_u8; 16 * 1024];
            loop {
                budget.check()?;
                let count = input
                    .read(&mut chunk)
                    .map_err(|error| io_error("Read duplicate content", source, error))?;
                if count == 0 {
                    break;
                }
                budget.bytes += count as u64;
                if budget.bytes > MAX_COPY_BYTES {
                    return Err(CoreError::InvalidEdit(
                        "Duplicate exceeds the 64 MiB limit".into(),
                    ));
                }
                output
                    .write_all(&chunk[..count])
                    .map_err(|error| io_error("Write duplicate content", destination, error))?;
            }
            output
                .set_permissions(metadata.permissions())
                .map_err(|error| io_error("Preserve file permissions", destination, error))?;
            output
                .sync_all()
                .map_err(|error| io_error("Flush duplicate", destination, error))?;
        } else {
            return Err(CoreError::InvalidEdit(
                "Only regular files and folders can be duplicated".into(),
            ));
        }
        Ok(())
    }
}
struct CopyBudget<'a> {
    entries: usize,
    bytes: u64,
    cancellation: &'a CancellationToken,
    owns_staging: bool,
}
impl CopyBudget<'_> {
    fn check(&self) -> Result<()> {
        if self.cancellation.is_cancelled() {
            Err(CoreError::InvalidEdit("Duplicate was cancelled".into()))
        } else {
            Ok(())
        }
    }
}
fn open_copy_source(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    Ok(file)
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        from,
        rustix::fs::CWD,
        to,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(Into::into)
}
#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let mut from: Vec<u16> = from.as_os_str().encode_wide().collect();
    let mut to: Vec<u16> = to.as_os_str().encode_wide().collect();
    if from.contains(&0) || to.contains(&0) {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    from.push(0);
    to.push(0);
    // MoveFileW explicitly fails if a destination exists. Both buffers are terminated and live across the call.
    if unsafe { windows_sys::Win32::Storage::FileSystem::MoveFileW(from.as_ptr(), to.as_ptr()) }
        == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn rename_no_replace(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Uses the actual macOS Trash for a uniquely named temporary fixture, then restores it"]
    fn system_trash_round_trip_restores_only_its_owned_temporary_fixture() {
        let directory = tempfile::tempdir().unwrap();
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!("span-owned-trash-test-{}-{unique}.txt", std::process::id());
        let original = directory.path().join(&name);
        let trash_file = PathBuf::from(std::env::var_os("HOME").unwrap())
            .join(".Trash")
            .join(&name);
        assert!(!trash_file.exists());
        fs::write(&original, "Only this temporary test fixture may be moved").unwrap();
        let mut core = CoreWorkspace::open(directory.path()).unwrap();
        core.open_buffer(&name).unwrap();
        assert_eq!(core.trash_path(&name).unwrap(), vec![name.clone()]);
        assert!(!original.exists());
        assert_eq!(
            fs::read_to_string(&trash_file).unwrap(),
            "Only this temporary test fixture may be moved"
        );
        fs::rename(&trash_file, &original).unwrap();
        assert_eq!(
            core.open_buffer(&name).unwrap().text,
            "Only this temporary test fixture may be moved"
        );
    }

    #[test]
    fn trash_bridge_is_recoverable_and_only_evicts_after_success() {
        let directory = tempfile::tempdir().unwrap();
        let recovery = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("owned-test.txt"), "recover me").unwrap();
        let mut core = CoreWorkspace::open(directory.path()).unwrap();
        core.open_buffer("owned-test.txt").unwrap();
        assert!(core
            .trash_path_with("owned-test.txt", |_| Err(CoreError::InvalidEdit(
                "Trash unavailable".into()
            )))
            .is_err());
        assert_eq!(
            core.agent_read("owned-test.txt").unwrap().text,
            "recover me"
        );
        let recovered = recovery.path().join("owned-test.txt");
        let removed = core
            .trash_path_with("owned-test.txt", |source| {
                fs::rename(source, &recovered)
                    .map_err(|error| io_error("Test recoverable trash", source, error))
            })
            .unwrap();
        assert_eq!(removed, vec!["owned-test.txt"]);
        assert_eq!(fs::read_to_string(&recovered).unwrap(), "recover me");
        fs::rename(recovered, directory.path().join("owned-test.txt")).unwrap();
        assert_eq!(
            core.open_buffer("owned-test.txt").unwrap().text,
            "recover me"
        );
    }
}
