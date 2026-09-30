use std::{
    fs, io,
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 80;
const MAX_FILE_BYTES: u64 = 32_000;
const MAX_TOTAL_BYTES: usize = 256_000;
const CONTEXT_EXTENSIONS: &[&str] = &[
    "c", "cc", "cpp", "cs", "go", "h", "hpp", "java", "js", "jsx", "md", "mjs", "mts", "php", "py",
    "rb", "rs", "scss", "sh", "sol", "sql", "toml", "ts", "tsx", "vue", "vy", "yaml", "yml",
];
const IGNORED_DIRS: &[&str] = &[
    ".aws",
    ".cache",
    ".expo",
    ".git",
    ".gnupg",
    ".local",
    ".next",
    ".ssh",
    ".venv",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
    "venv",
];

pub(super) fn collect_context(root: &Path) -> io::Result<String> {
    let files = collect_context_files(root)?;
    let mut context = String::new();
    for (path, content) in files {
        context.push_str(&format!("--- {} ---\n{}\n\n", path.display(), content));
    }
    Ok(context)
}

pub(super) fn collect_context_files(root: &Path) -> io::Result<Vec<(PathBuf, String)>> {
    let mut files = Vec::new();
    let mut total = 0usize;
    collect_files(root, root, &mut files, &mut total)?;
    Ok(files)
}

pub(super) fn format_context_preflight(files: &[(PathBuf, String)]) -> String {
    let total_bytes = files
        .iter()
        .map(|(_, content)| content.len())
        .sum::<usize>();
    let mut output = format!(
        "Context preflight (local only; no provider request)\nSelected {} file(s), {total_bytes} of {MAX_TOTAL_BYTES} bytes maximum.\n",
        files.len()
    );
    if files.is_empty() {
        output.push_str("No eligible workspace files were selected.\n");
    }
    for (path, content) in files {
        output.push_str(&format!("- {} — {} bytes\n", path.display(), content.len()));
    }
    output.push_str(
        "Only paths and byte counts are shown. A later request re-collects context, so its selection may differ if files change.",
    );
    output
}

fn collect_files(
    root: &Path,
    dir: &Path,
    files: &mut Vec<(PathBuf, String)>,
    total: &mut usize,
) -> io::Result<()> {
    if files.len() >= MAX_FILES || *total >= MAX_TOTAL_BYTES {
        return Ok(());
    }
    let mut entries = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if files.len() >= MAX_FILES || *total >= MAX_TOTAL_BYTES {
            break;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "package-lock.json" || name == "pnpm-lock.yaml" {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if !IGNORED_DIRS.contains(&name.as_ref()) {
                collect_files(root, &path, files, total)?;
            }
            continue;
        }
        if !metadata.is_file()
            || metadata.len() > MAX_FILE_BYTES
            || !path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    CONTEXT_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
                })
        {
            continue;
        }
        let content = fs::read(&path)?;
        if content.contains(&0) || total.saturating_add(content.len()) > MAX_TOTAL_BYTES {
            continue;
        }
        let Ok(content) = String::from_utf8(content) else {
            continue;
        };
        let relative = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        *total += content.len();
        files.push((relative, content));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_preflight_lists_deterministic_paths_and_sizes_without_contents() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/b.rs"), "second-secret-body").unwrap();
        fs::write(root.path().join("a.md"), "first-secret-body").unwrap();
        let first = collect_context_files(root.path()).unwrap();
        let second = collect_context_files(root.path()).unwrap();
        assert_eq!(first, second);

        let preview = format_context_preflight(&first);
        assert!(preview.contains("Selected 2 file(s), 35 of 256000 bytes maximum."));
        assert!(preview.contains("- a.md — 17 bytes"));
        assert!(preview.contains("- src/b.rs — 18 bytes"));
        assert!(!preview.contains("first-secret-body"));
        assert!(!preview.contains("second-secret-body"));
    }

    #[test]
    fn context_preflight_preserves_existing_workspace_exclusions() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("visible.rs"), "visible").unwrap();
        fs::write(root.path().join(".env"), "HIDDEN=secret").unwrap();
        fs::write(root.path().join("package-lock.json"), "lockfile").unwrap();
        fs::write(
            root.path().join("too-large.rs"),
            vec![b'x'; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            root.path().join("visible.rs"),
            root.path().join("linked.rs"),
        )
        .unwrap();

        let files = collect_context_files(root.path()).unwrap();
        let preview = format_context_preflight(&files);
        assert_eq!(files.len(), 1);
        assert!(preview.contains("visible.rs"));
        assert!(!preview.contains(".env"));
        assert!(!preview.contains("package-lock.json"));
        assert!(!preview.contains("too-large.rs"));
        assert!(!preview.contains("linked.rs"));
        assert!(!preview.contains("HIDDEN=secret"));
    }

    #[test]
    fn empty_context_preflight_is_explicit() {
        assert!(format_context_preflight(&[]).contains("No eligible workspace files"));
    }

    #[test]
    fn workspace_context_skips_dotfiles_secrets_and_symlinks() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("src.rs"), "fn main() {}\n").unwrap();
        fs::write(root.path().join(".env"), "PRIVATE=not-for-context").unwrap();
        fs::create_dir(root.path().join(".ssh")).unwrap();
        fs::write(root.path().join(".ssh/id_key"), "not-for-context").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.path().join("src.rs"), root.path().join("linked.rs"))
            .unwrap();

        let context = collect_context(root.path()).unwrap();
        assert!(context.contains("fn main"));
        assert!(!context.contains("PRIVATE"));
        assert!(!context.contains("not-for-context"));
    }
}
