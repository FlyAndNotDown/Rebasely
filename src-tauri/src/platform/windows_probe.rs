//! Keep passive probe descendants owned even after their launcher exits.

use std::io;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};

use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

pub(crate) struct ProbeProcessTreeGuard {
    job: OwnedHandle,
}

impl ProbeProcessTreeGuard {
    fn new() -> io::Result<Self> {
        // An unnamed job with default security is private and not inheritable.
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // CreateJobObjectW returned a new owned handle; OwnedHandle closes it.
        let job = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // The pointer and size describe the live, correctly initialized structure.
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { job })
    }

    pub(crate) fn terminate(&self, _pid: u32) -> bool {
        // This private job contains only the suspended probe and its descendants.
        unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) != 0 }
    }

    /// Completed commands may have detached maintenance or credential helpers.
    /// Let them finish normally once the launcher and both output pipes end.
    pub(crate) fn disarm(&self) -> io::Result<()> {
        let limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // Clearing the private job's kill-on-close flag does not detach or
        // change membership while cancellation still owns the open job handle.
        if unsafe {
            SetInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

pub(crate) fn spawn_probe_command(
    command: &mut Command,
) -> io::Result<(Child, ProbeProcessTreeGuard)> {
    let tree = ProbeProcessTreeGuard::new()?;
    // A probe comes from background_command. Keep its no-console policy and
    // suspend the initial thread before any wrapper can create descendants.
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child = command.spawn()?;
    // Child owns a live process handle throughout assignment and resumption.
    let assigned =
        unsafe { AssignProcessToJobObject(tree.job.as_raw_handle(), child.as_raw_handle()) };
    let result = if assigned == 0 {
        Err(io::Error::last_os_error())
    } else {
        resume_initial_thread(child.id())
    };
    if let Err(error) = result {
        tree.terminate(child.id());
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok((child, tree))
}

fn resume_initial_thread(pid: u32) -> io::Result<()> {
    // SNAPTHREAD does not inspect modules or memory in other processes.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // The successful snapshot is a new, owned kernel handle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..THREADENTRY32::default()
    };
    // The API receives a writable structure with its required size initialized.
    if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut initial = None;
    loop {
        let owner_end = std::mem::offset_of!(THREADENTRY32, th32OwnerProcessID) + size_of::<u32>();
        if (entry.dwSize as usize) < owner_end {
            return Err(io::Error::other(
                "The probe thread information is incomplete.",
            ));
        }
        if entry.th32OwnerProcessID == pid {
            // Request only the rights needed to verify ownership and resume.
            let raw = unsafe {
                OpenThread(
                    THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                    0,
                    entry.th32ThreadID,
                )
            };
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            // OpenThread returned a new owned handle, held until after resume.
            let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
            // A snapshot ID could have been reused; never resume another process.
            let owner = unsafe { GetProcessIdOfThread(thread.as_raw_handle()) };
            if owner == 0 {
                return Err(io::Error::last_os_error());
            }
            if owner != pid {
                return Err(io::Error::other("The probe thread owner changed."));
            }
            if initial.replace(thread).is_some() {
                return Err(io::Error::other(
                    "The suspended probe has multiple initial threads.",
                ));
            }
        }
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        // Reuse the same valid snapshot and initialized entry for enumeration.
        if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                return Err(error);
            }
            break;
        }
    }
    let initial =
        initial.ok_or_else(|| io::Error::other("The probe initial thread was not found."))?;
    // CREATE_SUSPENDED supplied exactly one suspension; do not release any
    // additional suspension installed by another component or guess a thread.
    match unsafe { ResumeThread(initial.as_raw_handle()) } {
        1 => Ok(()),
        u32::MAX => Err(io::Error::last_os_error()),
        _ => Err(io::Error::other("The probe thread suspension changed.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::path::Path;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    const FIXTURE_MODE: &str = "REBASERAVEN_PROBE_FIXTURE_MODE";
    const FIXTURE_DIRECTORY: &str = "REBASERAVEN_PROBE_FIXTURE_DIRECTORY";

    struct OwnedTestChild(Child);

    impl Drop for OwnedTestChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    struct OwnedTestProcess(OwnedHandle);

    impl Drop for OwnedTestProcess {
        fn drop(&mut self) {
            // This handle was verified as a member of this test's private job.
            if unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) } == WAIT_TIMEOUT {
                // Test failures must not leave their own fixture process alive.
                unsafe { TerminateProcess(self.0.as_raw_handle(), 1) };
                unsafe { WaitForSingleObject(self.0.as_raw_handle(), 2_000) };
            }
        }
    }

    fn fixture(mode: &str, directory: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        let module = module_path!().split_once("::").unwrap().1;
        command
            .args([
                "--exact",
                &format!("{module}::probe_fixture"),
                "--nocapture",
            ])
            .env(FIXTURE_MODE, mode)
            .env(FIXTURE_DIRECTORY, directory)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null());
        command
    }

    fn wait_until(mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready() {
            assert!(
                Instant::now() < deadline,
                "the probe fixture did not become ready"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn probe_fixture() {
        let Ok(mode) = std::env::var(FIXTURE_MODE) else {
            return;
        };
        let directory = std::path::PathBuf::from(std::env::var_os(FIXTURE_DIRECTORY).unwrap());
        match mode.as_str() {
            "parent" => {
                let helper = fixture("helper", &directory).spawn().unwrap();
                std::fs::write(directory.join("helper-pid"), helper.id().to_string()).unwrap();
                wait_until(|| directory.join("ready").exists());
                // Intentionally leave an inherited-pipe child after the parent exits.
                std::process::exit(0);
            }
            "helper" => {
                std::fs::write(directory.join("ready"), b"ready").unwrap();
                std::thread::sleep(Duration::from_secs(60));
                std::process::exit(0);
            }
            "output" => {
                println!("probe stdout");
                eprintln!("probe stderr");
            }
            _ => panic!("unknown probe fixture mode"),
        }
    }

    #[test]
    fn suspended_probe_resumes_and_collects_both_output_pipes() {
        let temporary = tempfile::tempdir().unwrap();
        let mut command = fixture("output", temporary.path());
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let (child, tree) = spawn_probe_command(&mut command).unwrap();
        let output = child.wait_with_output().unwrap();
        drop(tree);
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("probe stdout"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("probe stderr"));
    }

    #[test]
    fn closing_job_ends_pipe_holders_after_parent_exit_without_harming_other_processes() {
        assert_pipe_helper_cleanup(false, false);
    }

    #[test]
    fn terminating_job_ends_pipe_holders_before_the_job_handle_closes() {
        assert_pipe_helper_cleanup(true, false);
    }

    #[test]
    fn disarming_a_completed_commands_job_preserves_its_helpers() {
        assert_pipe_helper_cleanup(false, true);
    }

    fn assert_helper_stopped(helper: &OwnedTestProcess) {
        // The helper's owned process handle remains valid after it exits.
        assert_eq!(
            unsafe { WaitForSingleObject(helper.0.as_raw_handle(), 2_000) },
            WAIT_OBJECT_0,
            "the job left its pipe-holding helper alive after its launcher exited"
        );
    }

    fn assert_pipe_helper_cleanup(terminate: bool, disarm: bool) {
        let temporary = tempfile::tempdir().unwrap();
        let independent_directory = tempfile::tempdir().unwrap();
        let mut independent = OwnedTestChild(
            fixture("helper", independent_directory.path())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        wait_until(|| independent_directory.path().join("ready").exists());

        let mut command = fixture("parent", temporary.path());
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let (child, tree) = spawn_probe_command(&mut command).unwrap();
        let mut parent = OwnedTestChild(child);
        let mut parent_status = None;
        wait_until(|| {
            parent_status = parent.0.try_wait().unwrap();
            parent_status.is_some()
        });
        assert!(parent_status.unwrap().success());
        let pid: u32 = std::fs::read_to_string(temporary.path().join("helper-pid"))
            .unwrap()
            .parse()
            .unwrap();
        // The helper is still alive and belongs to the private job at this point.
        let raw = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        assert!(!raw.is_null(), "could not open the owned probe helper");
        // OpenProcess returned a new, owned process handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut in_job = 0;
        // Verify ownership before installing the fixture's fallback cleanup.
        assert_ne!(
            unsafe {
                IsProcessInJob(
                    handle.as_raw_handle(),
                    tree.job.as_raw_handle(),
                    &mut in_job,
                )
            },
            0
        );
        assert_ne!(in_job, 0);
        let helper = OwnedTestProcess(handle);
        assert_eq!(
            unsafe { WaitForSingleObject(helper.0.as_raw_handle(), 0) },
            WAIT_TIMEOUT
        );

        if disarm {
            tree.disarm().unwrap();
            drop(tree);
            assert_eq!(
                unsafe { WaitForSingleObject(helper.0.as_raw_handle(), 0) },
                WAIT_TIMEOUT,
                "normal completion must let its detached helper finish"
            );
            assert!(independent.0.try_wait().unwrap().is_none());
            // End only this fixture so its inherited pipes can drain below.
            drop(helper);
        } else if terminate {
            assert!(tree.terminate(parent.0.id()));
            assert_helper_stopped(&helper);
            assert!(independent.0.try_wait().unwrap().is_none());
            // Keep the job handle alive through those assertions so closing it
            // cannot hide a regression in the explicit cancellation path.
            drop(tree);
        } else {
            drop(tree);
            assert_helper_stopped(&helper);
        }
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        parent
            .0
            .stdout
            .take()
            .unwrap()
            .read_to_end(&mut stdout)
            .unwrap();
        parent
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_end(&mut stderr)
            .unwrap();
        assert!(independent.0.try_wait().unwrap().is_none());
    }
}
