//! Windows backend: OpenProcess for liveness, `taskkill` for ending processes and their trees,
//! hidden-console process groups for detached spawns.

use std::io;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: the handle is opened with query-only access and closed right after.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

/// `taskkill` on a pid; `tree` also ends its children, `force` skips the polite request.
fn taskkill(pid: u32, tree: bool, force: bool) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string()]);
    if tree {
        cmd.arg("/T");
    }
    if force {
        cmd.arg("/F");
    }
    let _ = cmd
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Asks a direct child to end (there is no SIGTERM: the server also has its shutdown route).
pub fn term_child(pid: u32) {
    taskkill(pid, false, false);
}

/// Ends the whole tree led by `pgid` (the server's pid: it was started as its own group).
pub fn kill_tree(pgid: u32) {
    taskkill(pgid, true, true);
}

/// A process that is going to be ended. Windows has no pidfd: it is the pid verified by the health.
pub struct Target {
    pid: u32,
}

impl Target {
    pub fn open(pid: u32) -> Self {
        Self { pid }
    }

    /// Asks the process to end.
    pub fn term(&self) {
        taskkill(self.pid, false, false);
    }

    /// Ends the process and its children for good.
    pub fn kill(&self) {
        taskkill(self.pid, true, true);
    }
}

/// Own process group and a hidden console: closing the app sends nothing to the child, and the
/// processes it spawns do not open console windows.
pub fn detach(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

pub fn spawn_detached(cmd: &mut Command) -> io::Result<Child> {
    cmd.spawn()
}

/// Own group and no window for a short-lived helper, so its whole tree can be killed afterwards.
pub fn limit(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

/// Kills the tree of a child started with [`limit`].
pub fn kill_limited(child: &mut Child) {
    taskkill(child.id(), true, true);
}

/// Working directory when the user's home is unavailable.
pub fn fallback_cwd() -> PathBuf {
    std::env::temp_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_pid_is_alive_and_a_reaped_child_is_not() {
        assert!(pid_alive(std::process::id()));
        let mut child = Command::new("cmd").args(["/C", "exit 0"]).spawn().unwrap();
        child.wait().unwrap();
        assert!(!pid_alive(child.id()));
    }

    #[test]
    fn kill_limited_ends_the_helper() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "ping -n 30 127.0.0.1 >NUL"]);
        limit(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        kill_limited(&mut child);
        assert!(!child.wait().unwrap().success());
    }
}
