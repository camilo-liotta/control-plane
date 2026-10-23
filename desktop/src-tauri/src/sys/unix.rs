//! Unix backend: kill(2) signals, process groups, pidfd on Linux.

use std::io;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command};

pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only asks whether the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Signal to a direct child that has not been reaped yet (its pid cannot be reused).
fn signal_child(pid: u32, sig: libc::c_int) {
    // SAFETY: only called with the pid of a `Child` that try_wait still reports as running.
    unsafe {
        libc::kill(pid as libc::pid_t, sig);
    }
}

fn signal_group(pgid: u32, sig: libc::c_int) {
    // SAFETY: the group of our own server (the app started it with setsid); only called with
    // the unreaped leader or with a fresh health that confirms the server is still there.
    unsafe {
        libc::kill(-(pgid as libc::pid_t), sig);
    }
}

/// SIGTERM to a direct child that has not been reaped yet.
pub fn term_child(pid: u32) {
    signal_child(pid, libc::SIGTERM);
}

/// SIGKILL to the whole process group led by `pgid`.
pub fn kill_tree(pgid: u32) {
    signal_group(pgid, libc::SIGKILL);
}

/// A process that is going to be signaled. On Linux a pidfd is opened **before** verifying it
/// with the health: if the health then confirms that pid is the server, the signals go to that
/// process and not to another one that reuses the pid. On macOS, the pid.
pub struct Target {
    pid: u32,
    #[cfg(target_os = "linux")]
    fd: Option<std::os::fd::OwnedFd>,
}

impl Target {
    pub fn open(pid: u32) -> Self {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::FromRawFd;
            // SAFETY: pidfd_open returns a new fd (or -1); if valid it becomes ours.
            let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
            let fd = (raw >= 0).then(|| unsafe { std::os::fd::OwnedFd::from_raw_fd(raw as i32) });
            Self { pid, fd }
        }
        #[cfg(not(target_os = "linux"))]
        Self { pid }
    }

    /// Asks the process to end (SIGTERM).
    pub fn term(&self) {
        self.signal(libc::SIGTERM);
    }

    /// Ends the process for good (SIGKILL).
    pub fn kill(&self) {
        self.signal(libc::SIGKILL);
    }

    fn signal(&self, sig: libc::c_int) {
        #[cfg(target_os = "linux")]
        if let Some(fd) = &self.fd {
            use std::os::fd::AsRawFd;
            // SAFETY: own pidfd; if the process already ended it fails with ESRCH and reaches nobody.
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    sig,
                    std::ptr::null::<libc::siginfo_t>(),
                    0u32,
                );
            }
            return;
        }
        // SAFETY: no pidfd (macOS or an old kernel): the pid just verified by the health.
        unsafe {
            libc::kill(self.pid as libc::pid_t, sig);
        }
    }
}

/// Marks every fd above 2 as close-on-exec: the server inherits nothing from the app (window
/// sockets, GTK pipes) that could tie it to the app.
fn cloexec_all() {
    #[cfg(target_os = "linux")]
    // SAFETY: close_range with CLOSE_RANGE_CLOEXEC only changes flags; if the kernel lacks it,
    // it fails with ENOSYS and we fall back to the loop.
    unsafe {
        const CLOSE_RANGE_CLOEXEC: libc::c_uint = 1 << 2;
        if libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, CLOSE_RANGE_CLOEXEC) == 0 {
            return;
        }
    }
    // SAFETY: fcntl on fds that may not exist: fails with no effect.
    unsafe {
        let max = libc::sysconf(libc::_SC_OPEN_MAX).clamp(256, 65536) as libc::c_int;
        for fd in 3..max {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags >= 0 {
                libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
    }
}

/// Own session and process group, no controlling terminal, no inherited fds: closing the app
/// sends nothing to the child.
pub fn detach(cmd: &mut Command) {
    // SAFETY: between fork and exec only setsid and fcntl run, which are async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            cloexec_all();
            Ok(())
        });
    }
}

pub fn spawn_detached(cmd: &mut Command) -> io::Result<Child> {
    cmd.spawn()
}

/// Own session for a short-lived helper, so its whole group can be killed afterwards.
pub fn limit(cmd: &mut Command) {
    // SAFETY: setsid is async-signal-safe; nothing else is touched between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Kills the group of a child started with [`limit`].
pub fn kill_limited(child: &mut Child) {
    // SAFETY: kill to a group we created ourselves (setsid); if it is gone, it fails with no effect.
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
}

/// Working directory when the user's home is unavailable.
pub fn fallback_cwd() -> PathBuf {
    PathBuf::from("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_pid_is_alive_and_a_reaped_child_is_not() {
        assert!(pid_alive(std::process::id()));
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        child.wait().unwrap();
        assert!(!pid_alive(child.id()));
    }

    #[test]
    fn kill_limited_kills_the_helper_with_sigkill() {
        use std::os::unix::process::ExitStatusExt;
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30 & wait"]);
        limit(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        kill_limited(&mut child);
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
    }
}
