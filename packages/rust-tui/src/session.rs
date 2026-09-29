use std::{
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};

const MAX_SESSION_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MESSAGES: usize = 500;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SessionMessage {
    pub role: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SessionTranscript {
    version: u8,
    pub messages: Vec<SessionMessage>,
}

impl SessionTranscript {
    pub fn from_messages(messages: impl IntoIterator<Item = (String, String)>) -> Self {
        let messages = messages
            .into_iter()
            .filter(|(role, _)| role == "you" || role == "assistant")
            .map(|(role, text)| SessionMessage {
                role,
                text: redact_secrets(&text),
            })
            .collect();
        Self {
            version: 1,
            messages,
        }
    }
}

pub fn validate_name(name: &str) -> Result<(), String> {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 48
        || !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(byte))
        || is_reserved_name(name)
    {
        return Err(
            "session name must be 1-48 lowercase letters, digits, hyphens, or underscores".into(),
        );
    }
    Ok(())
}

fn is_reserved_name(name: &str) -> bool {
    matches!(name, "con" | "prn" | "aux" | "nul")
        || ["com", "lpt"]
            .iter()
            .any(|prefix| (1..=9).any(|number| name == format!("{prefix}{number}")))
}

fn sessions_dir() -> io::Result<PathBuf> {
    let base = if let Some(state_home) = env::var_os("XDG_STATE_HOME") {
        let path = PathBuf::from(state_home);
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "XDG_STATE_HOME must be an absolute path",
            ));
        }
        path
    } else if cfg!(windows) {
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is not set"))?
    } else {
        env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?
            .join(".local/state")
    };

    Ok(base.join("terminal221b/sessions"))
}

fn prepare_sessions_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let metadata = fs::symlink_metadata(dir)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "session storage path must be a real directory",
        ));
    }
    set_directory_permissions(dir)?;
    Ok(())
}

#[cfg(unix)]
fn set_directory_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_directory_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

pub fn save(name: &str, transcript: &SessionTranscript) -> Result<PathBuf, String> {
    let dir = sessions_dir().map_err(|error| format!("session storage: {error}"))?;
    save_in(&dir, name, transcript)
}

fn save_in(dir: &Path, name: &str, transcript: &SessionTranscript) -> Result<PathBuf, String> {
    validate_name(name)?;
    if transcript.messages.len() > MAX_MESSAGES {
        return Err(format!(
            "session cannot contain more than {MAX_MESSAGES} messages"
        ));
    }
    prepare_sessions_dir(dir).map_err(|error| format!("session storage: {error}"))?;
    let destination = dir.join(format!("{name}.json"));
    if fs::symlink_metadata(&destination).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("refusing to replace a symlinked session file".into());
    }
    let bytes = serde_json::to_vec_pretty(transcript)
        .map_err(|error| format!("could not serialize session: {error}"))?;
    if bytes.len() as u64 > MAX_SESSION_BYTES {
        return Err("session exceeds the 2 MiB storage limit".into());
    }

    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = dir.join(format!(".{name}.{}.{}.tmp", std::process::id(), sequence));
    let result = write_atomic(&temporary, &destination, &bytes);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("could not save session: {error}"))?;
    Ok(destination)
}

fn write_atomic(temporary: &Path, destination: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    set_file_mode(&mut options);
    let mut file = options.open(temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    replace_file(temporary, destination)?;
    sync_directory(temporary.parent().expect("temporary file has a parent"))
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
fn replace_file(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let existing = temporary
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    let new = destination
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            new.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn set_file_mode(options: &mut fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_file_mode(_options: &mut fs::OpenOptions) {}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

pub fn load(name: &str) -> Result<SessionTranscript, String> {
    let dir = sessions_dir().map_err(|error| format!("session storage: {error}"))?;
    load_from(&dir, name)
}

fn load_from(dir: &Path, name: &str) -> Result<SessionTranscript, String> {
    validate_name(name)?;
    let path = dir.join(format!("{name}.json"));
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("could not inspect session {name}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("session {name} is not a regular file"));
    }
    if metadata.len() > MAX_SESSION_BYTES {
        return Err(format!("session {name} exceeds the 2 MiB storage limit"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(&path)
        .and_then(|file| file.take(MAX_SESSION_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("could not read session {name}: {error}"))?;
    if bytes.len() as u64 > MAX_SESSION_BYTES {
        return Err(format!("session {name} exceeds the 2 MiB storage limit"));
    }
    let transcript: SessionTranscript = serde_json::from_slice(&bytes)
        .map_err(|error| format!("session {name} is corrupt: {error}"))?;
    if transcript.version != 1 {
        return Err(format!(
            "session {name} uses unsupported format version {}",
            transcript.version
        ));
    }
    if transcript.messages.len() > MAX_MESSAGES
        || transcript
            .messages
            .iter()
            .any(|message| !matches!(message.role.as_str(), "you" | "assistant"))
    {
        return Err(format!("session {name} contains invalid transcript data"));
    }
    Ok(transcript)
}

pub fn list() -> Result<Vec<String>, String> {
    let dir = sessions_dir().map_err(|error| format!("session storage: {error}"))?;
    list_from(&dir)
}

fn list_from(dir: &Path) -> Result<Vec<String>, String> {
    prepare_sessions_dir(dir).map_err(|error| format!("session storage: {error}"))?;
    let entries = fs::read_dir(dir).map_err(|error| format!("could not list sessions: {error}"))?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("could not read session entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("could not inspect session entry: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        if path
            .extension()
            .is_some_and(|extension| extension == "json")
            && let Some(name) = path.file_stem().and_then(|stem| stem.to_str())
            && validate_name(name).is_ok()
        {
            names.push(name.to_string());
        }
    }
    names.sort();
    Ok(names)
}

fn redact_secrets(text: &str) -> String {
    let mut redacted = String::with_capacity(text.len());
    let mut in_private_key = false;
    for line in text.lines() {
        if line.contains("-----BEGIN ") && line.contains(" PRIVATE KEY-----") {
            in_private_key = true;
            redacted.push_str("[REDACTED PRIVATE KEY]");
            redacted.push('\n');
            continue;
        }
        if in_private_key {
            if line.contains("-----END ") && line.contains(" PRIVATE KEY-----") {
                in_private_key = false;
            }
            continue;
        }
        redacted.push_str(&redact_line(line));
        redacted.push('\n');
    }
    if !text.ends_with('\n') && redacted.ends_with('\n') {
        redacted.pop();
    }
    redacted
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let markers = [
        "api_key=",
        "api-key=",
        "api key=",
        "token=",
        "secret=",
        "password=",
        "private_key=",
        "private-key=",
        "bearer ",
        "sk-ant-",
        "github_pat_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "xoxb-",
        "xoxp-",
        "aiza",
    ];
    let mut output = String::new();
    let mut cursor = 0;
    while cursor < line.len() {
        let remaining = &lower[cursor..];
        let marker = markers
            .iter()
            .filter_map(|marker| {
                remaining
                    .find(&marker.to_ascii_lowercase())
                    .map(|index| (index, *marker))
            })
            .min_by_key(|(index, _)| *index);
        let Some((index, marker)) = marker else {
            output.push_str(&line[cursor..]);
            break;
        };
        let start = cursor + index;
        output.push_str(&line[cursor..start]);
        let value_start = start + marker.len();
        output.push_str("[REDACTED]");
        cursor = line[value_start..]
            .find(char::is_whitespace)
            .map_or(line.len(), |end| value_start + end);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_names_reject_paths_reserved_names_and_unsupported_characters() {
        for name in [
            "",
            ".",
            "..",
            "../outside",
            "Upper",
            "has space",
            "con",
            "lpt2",
        ] {
            assert!(validate_name(name).is_err(), "{name}");
        }
        assert!(validate_name(&"a".repeat(49)).is_err());
        assert!(validate_name("build_12-session").is_ok());
    }

    #[test]
    fn transcript_round_trips_and_overwrites_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let first = SessionTranscript::from_messages([
            ("system".into(), "workspace source context".into()),
            ("you".into(), "hello".into()),
            ("assistant".into(), "welcome".into()),
        ]);
        save_in(dir.path(), "morning", &first).unwrap();
        assert_eq!(load_from(dir.path(), "morning").unwrap(), first);

        let second = SessionTranscript::from_messages([("you".into(), "new prompt".into())]);
        save_in(dir.path(), "morning", &second).unwrap();
        assert_eq!(load_from(dir.path(), "morning").unwrap(), second);
        assert_eq!(list_from(dir.path()).unwrap(), ["morning"]);
        assert!(fs::read_dir(dir.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
    }

    #[test]
    fn session_storage_excludes_system_context_and_redacts_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = SessionTranscript::from_messages([
            ("system".into(), "collected repository source".into()),
            (
                "you".into(),
                "ANTHROPIC_API_KEY=sk-ant-example-secret Bearer ghp_example-secret".into(),
            ),
            (
                "assistant".into(),
                "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----".into(),
            ),
        ]);

        save_in(dir.path(), "safe", &transcript).unwrap();
        let contents = fs::read_to_string(dir.path().join("safe.json")).unwrap();
        assert!(!contents.contains("collected repository source"));
        assert!(!contents.contains("sk-ant-example-secret"));
        assert!(!contents.contains("ghp_example-secret"));
        assert!(!contents.contains("private-material"));
        assert!(contents.contains("[REDACTED]"));
    }

    #[test]
    fn corrupt_and_oversized_sessions_return_errors() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(dir.path().join("broken.json"), "{").unwrap();
        assert!(
            load_from(dir.path(), "broken")
                .unwrap_err()
                .contains("corrupt")
        );

        fs::write(
            dir.path().join("large.json"),
            vec![b'x'; MAX_SESSION_BYTES as usize + 1],
        )
        .unwrap();
        assert!(
            load_from(dir.path(), "large")
                .unwrap_err()
                .contains("2 MiB")
        );
    }

    #[cfg(unix)]
    #[test]
    fn session_directory_and_file_have_restrictive_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        save_in(
            dir.path(),
            "private",
            &SessionTranscript::from_messages([("you".into(), "hello".into())]),
        )
        .unwrap();
        assert_eq!(
            fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(dir.path().join("private.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn load_rejects_symlinked_session_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path()).unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linked.json")).unwrap();
        assert!(
            load_from(dir.path(), "linked")
                .unwrap_err()
                .contains("regular file")
        );
    }
}
