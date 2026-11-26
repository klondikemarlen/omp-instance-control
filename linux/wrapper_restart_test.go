package linux

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestWrapperRestartHarness(t *testing.T) {
	root := os.Getenv("OMPI_TEST_WRAPPER_ROOT")
	if root == "" {
		t.Skip("helper process only")
	}
	stdinIsTerminal = func() bool { return true }
	stdoutIsTerminal = func() bool { return true }
	installed := os.Getenv("OMPI_TEST_WRAPPER_PATH")
	var args []string
	if os.Getenv(execStatePathEnv) == "" {
		os.Args[0] = installed
		args = []string{"--profile", "work", "--config", "settings.json", "--restore=original-session", "--system-prompt=--restore", "initial prompt"}
		// Keep the production exec path and argv0, selecting only this test after exec.
		execWrapperProcess = func(path string, argv, env []string) error {
			return syscall.Exec(path, append(argv, "-test.run=^TestWrapperRestartHarness$"), env)
		}
	} else {
		if os.Args[0] != installed {
			t.Fatalf("replacement argv0 = %q, want %q", os.Args[0], installed)
		}
		executing, err := os.Stat("/proc/self/exe")
		if err != nil {
			t.Fatal(err)
		}
		selected, err := os.Stat(installed)
		if err != nil {
			t.Fatal(err)
		}
		if !os.SameFile(executing, selected) {
			t.Fatal("replacement did not execute the newly installed image")
		}
	}
	adapter := filepath.Join(root, "adapter.js")
	prResume := os.Getenv("OMPI_TEST_PR_RESUME_STATUS") != ""
	var code int
	var err error
	if prResume && os.Getenv(execStatePathEnv) == "" {
		code, err = LaunchPullRequest(testPRResumeURL, "work", adapter, "test")
	} else {
		code, err = Launch(args, adapter, "test")
	}
	if prResume {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(code)
	}
	if err != nil || code != 0 {
		t.Fatalf("native wrapper returned code=%d err=%v", code, err)
	}
}

func TestNativeImageMetadataUsesExecutingImageIdentity(t *testing.T) {
	installedPath := filepath.Join(t.TempDir(), "installed-ompi")
	if err := os.WriteFile(installedPath, []byte("new installed image"), 0700); err != nil {
		t.Fatal(err)
	}
	var executingImage syscall.Stat_t
	if err := syscall.Stat("/proc/self/exe", &executingImage); err != nil {
		t.Fatal(err)
	}
	metadata := nativeImageMetadata(installedPath, "0.15.2", nil)
	if metadata == nil {
		t.Fatal("native image metadata was not captured")
	}
	if metadata.Device != strconv.FormatUint(uint64(executingImage.Dev), 10) ||
		metadata.Inode != strconv.FormatUint(executingImage.Ino, 10) {
		t.Fatalf("image identity = device %q inode %q, want executing image device %d inode %d",
			metadata.Device, metadata.Inode, executingImage.Dev, executingImage.Ino)
	}
}

func TestWrapperRestartExecutesAtomicallyReplacedBinaryAndRetainsOwnership(t *testing.T) {
	root, err := os.MkdirTemp("", "wx-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	cwd := filepath.Join(root, "current-project")
	if err := os.Mkdir(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	session := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(session, []byte("persisted session"), 0600); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(root, "invocations.jsonl")
	prepareFakeOMP(t, root, logPath, session, cwd, "valid")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(root, "ompi")
	updated := filepath.Join(root, "updated-ompi")
	if err := os.WriteFile(installed, []byte("old executable"), 0700); err != nil {
		t.Fatal(err)
	}
	image, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(updated, image, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OMPI_TEST_WRAPPER_ROOT", root)
	t.Setenv("OMPI_TEST_WRAPPER_PATH", installed)
	t.Setenv("OMPI_TEST_WRAPPER_REPLACEMENT", updated)
	t.Setenv("OMPI_TEST_RESTART_WRAPPER", "1")
	t.Setenv("OMPI_TEST_CHECK_LOCK", "1")
	process := exec.Command(binary, "-test.run=^TestWrapperRestartHarness$")
	process.Dir = root
	if output, err := process.CombinedOutput(); err != nil {
		t.Fatalf("wrapper replacement failed: %v\n%s", err, output)
	}
	calls := readInvocations(t, logPath)
	if len(calls) != 2 {
		t.Fatalf("wrapper replacement launched %d OMP children, want two", len(calls))
	}
	first, second := calls[0], calls[1]
	if first.Launch["supportsInstalledWrapperSelection"] != true || second.Launch["supportsInstalledWrapperSelection"] != true {
		t.Fatal("native launcher did not advertise installed-wrapper selection")
	}
	if first.Token == second.Token || first.Launch["restoreId"] != second.Launch["restoreId"] ||
		!reflect.DeepEqual(first.Launch["scope"], second.Launch["scope"]) {
		t.Fatalf("replacement lost launch identity or scope: first=%#v second=%#v", first, second)
	}
	if !contains(first.Args, "--restore=original-session") {
		t.Fatalf("initial OMP invocation did not receive the explicit restore option: %#v", first.Args)
	}
	wantSaved := []any{"--profile", "work", "--config", filepath.Join(root, "settings.json"), "--system-prompt=--restore"}
	if !reflect.DeepEqual(first.Launch["resumeArgs"], wantSaved) {
		t.Fatalf("initial launch metadata retained one-shot options or changed literal values: %#v", first.Launch["resumeArgs"])
	}
	wantReplacement := []string{
		"-e", filepath.Join(root, "adapter.js"),
		"--profile", "work",
		"--config", filepath.Join(root, "settings.json"),
		"--system-prompt=--restore",
		"-r", session,
	}
	if second.CWD != cwd || !reflect.DeepEqual(second.Args, wantReplacement) {
		t.Fatalf("replacement did not pass only normalized options and the selected transcript: %#v", second)
	}
	correlation := second.Launch["lastRestart"].(map[string]any)
	if correlation["operationId"] != "operation-123" || correlation["previousInstanceId"] != "00000000000000000000000000000001" {
		t.Fatalf("replacement lost restart correlation: %#v", correlation)
	}
}

func TestWrapperRestartPreservesCancelledPRResumeExitStatus(t *testing.T) {
	root := t.TempDir()
	logPath := filepath.Join(root, "invocations.jsonl")
	session := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(session, []byte("session after cancelling PR resume"), 0600); err != nil {
		t.Fatal(err)
	}
	prepareFakeOMP(t, root, logPath, session, root, "valid")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(root, "ompi")
	if err := os.Symlink(binary, installed); err != nil {
		t.Fatal(err)
	}
	overlay := filepath.Join(root, "operator.yml")
	t.Setenv("PI_CONFIG_FILES", overlay)
	t.Setenv("OMPI_TEST_PR_RESUME_INITIAL_CONFIG", overlay)
	t.Setenv("OMPI_TEST_PR_RESUME_STATUS", "cancelled")
	t.Setenv("OMPI_TEST_WRAPPER_ROOT", root)
	t.Setenv("OMPI_TEST_WRAPPER_PATH", installed)
	t.Setenv("OMPI_TEST_RESTART_WRAPPER", "1")
	process := exec.Command(binary, "-test.run=^TestWrapperRestartHarness$")
	process.Dir = root

	output, err := process.CombinedOutput()

	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 ||
		!strings.Contains(string(output), "the PR resume was not completed before the terminal restarted") {
		t.Fatalf("expected unconfirmed PR resume exit after native restart: err=%v\n%s", err, output)
	}
	calls := readInvocations(t, logPath)
	if len(calls) != 2 || !containsPair(calls[1].Args, "-r", session) {
		t.Fatalf("PR cancellation blocked the independent native restart: %#v", calls)
	}
}

func TestPendingWrapperRestartRefusesPersistedNativeRestore(t *testing.T) {
	fixtureScope, session := newRestoreFixture(t, strings.Repeat("c", 32), stoppedRestoreOwner())
	t.Setenv("PI_CONFIG_DIR", fixtureScope.ConfigRoot)
	t.Setenv("PI_CODING_AGENT_DIR", fixtureScope.AgentDir)
	scope, err := protocol.GetScope("default", session.CWD)
	if err != nil {
		t.Fatal(err)
	}
	state := wrapperExecState{
		Version:     1,
		Token:       strings.Repeat("b", 32),
		Scope:       scope,
		Args:        []string{"--profile=default", "--system-prompt=--restore"},
		CWD:         session.CWD,
		SessionFile: session.SessionFile,
		Restart: restartRecord{
			OperationID:        "legacy-restart",
			PreviousInstanceID: strings.Repeat("c", 32),
		},
	}
	if err := validateWrapperExecState(state, 0); err != nil {
		t.Fatalf("pending restart with a literal --restore value refused: %v", err)
	}
	state.Args = append(state.Args, "--restore")
	if err := validateWrapperExecState(state, 0); err == nil {
		t.Fatal("pending restart accepted a persisted native restore option")
	}
}

func TestFailedWrapperExecRestoresLockDescriptorFlags(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_RUNTIME_DIR", root)
	t.Setenv("PI_CONFIG_DIR", filepath.Join(root, "config"))
	t.Setenv("PI_CODING_AGENT_DIR", "")
	scope, err := protocol.GetScope("default", root)
	if err != nil {
		t.Fatal(err)
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	restoreID := strings.Repeat("a", 32)
	lock, err := lockRestoreSnapshot(directories, restoreID)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	before, _, errno := syscall.Syscall(syscall.SYS_FCNTL, lock.Fd(), uintptr(syscall.F_GETFD), 0)
	if errno != 0 {
		t.Fatal(errno)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	originalExec := execWrapperProcess
	execWrapperProcess = func(string, []string, []string) error { return syscall.EACCES }
	t.Cleanup(func() { execWrapperProcess = originalExec })
	restart := &restartRecord{OperationID: "restart", PreviousInstanceID: strings.Repeat("b", 32)}
	err = execWrapperReplacement(root, executable, scope, []string{}, root, filepath.Join(root, "session.jsonl"), restart, restoreID, lock, nil, false)
	if !errors.Is(err, syscall.EACCES) {
		t.Fatalf("exec failure was not reported: %v", err)
	}
	after, _, errno := syscall.Syscall(syscall.SYS_FCNTL, lock.Fd(), uintptr(syscall.F_GETFD), 0)
	if errno != 0 || before != after {
		t.Fatalf("failed exec changed descriptor flags: before=%d after=%d err=%v", before, after, errno)
	}
	other, err := lockRestoreSnapshot(directories, restoreID)
	if err == nil {
		other.Close()
		t.Fatal("failed exec released the existing restore lock")
	}
}

func TestPinnedNativeTargetRejectsImageReplacedBeforeOpen(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "ompi")
	if err := os.WriteFile(executable, []byte("candidate A"), 0700); err != nil {
		t.Fatal(err)
	}
	target := installedNativeTarget(t, executable)
	replacement := filepath.Join(root, "replacement")
	if err := os.WriteFile(replacement, []byte("candidate B"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, executable); err != nil {
		t.Fatal(err)
	}
	restart := &restartRecord{OperationID: "restart", PreviousInstanceID: strings.Repeat("b", 32)}
	originalExec := execWrapperProcess
	execWrapperProcess = func(string, []string, []string) error {
		t.Fatal("mismatched installed image reached exec")
		return nil
	}
	t.Cleanup(func() { execWrapperProcess = originalExec })
	err := execWrapperReplacement(root, executable, protocol.Scope{}, nil, root, filepath.Join(root, "session"), restart, "", nil, target, false)
	if err == nil || !strings.Contains(err.Error(), "changed after verification") {
		t.Fatalf("mismatched installed image was not rejected explicitly: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, execStateFilename)); !os.IsNotExist(err) {
		t.Fatalf("mismatched image wrote restart state: %v", err)
	}
}

func TestOpenedNativeImageReplacementHarness(t *testing.T) {
	root := os.Getenv("OMPI_TEST_OPENED_IMAGE_ROOT")
	if root == "" {
		t.Skip("helper process only")
	}
	executable := filepath.Join(root, "ompi")
	replacement := filepath.Join(root, "replacement")
	if os.Getenv(execStatePathEnv) != "" {
		if os.Args[0] != executable {
			t.Fatalf("replacement argv0 = %q, want %q", os.Args[0], executable)
		}
		return
	}
	var target *protocol.NativeTarget
	if os.Getenv("OMPI_TEST_OPENED_IMAGE_MODE") == "pinned" {
		target = installedNativeTarget(t, executable)
	}
	originalExec := execWrapperProcess
	execWrapperProcess = func(path string, argv, env []string) error {
		number, ok := strings.CutPrefix(path, "/proc/self/fd/")
		if !ok {
			t.Fatalf("replacement exec path = %q, want a procfd path", path)
		}
		fd, err := strconv.Atoi(number)
		if err != nil {
			t.Fatal(err)
		}
		flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), uintptr(syscall.F_GETFD), 0)
		if errno != 0 || flags&syscall.FD_CLOEXEC == 0 {
			t.Fatalf("replacement descriptor is not close-on-exec: flags=%d err=%v", flags, errno)
		}
		if err := os.Rename(replacement, executable); err != nil {
			return err
		}
		return syscall.Exec(path, append(argv, "-test.run=^TestOpenedNativeImageReplacementHarness$"), env)
	}
	defer func() { execWrapperProcess = originalExec }()
	restart := &restartRecord{OperationID: "restart", PreviousInstanceID: strings.Repeat("b", 32)}
	if err := execWrapperReplacement(root, executable, protocol.Scope{}, nil, root, filepath.Join(root, "session"), restart, "", nil, target, false); err != nil {
		t.Fatal(err)
	}
	t.Fatal("native replacement returned without executing")
}

func TestOpenedNativeImageSurvivesAtomicPathReplacement(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	image, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	replacement, err := os.ReadFile("/bin/false")
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"installed", "pinned"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Chmod(root, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "ompi"), image, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "replacement"), replacement, 0700); err != nil {
				t.Fatal(err)
			}
			process := exec.Command(executable, "-test.run=^TestOpenedNativeImageReplacementHarness$")
			process.Env = append(os.Environ(), "OMPI_TEST_OPENED_IMAGE_ROOT="+root, "OMPI_TEST_OPENED_IMAGE_MODE="+mode)
			if output, err := process.CombinedOutput(); err != nil {
				t.Fatalf("the opened image did not run after atomic replacement: %v\n%s", err, output)
			}
		})
	}
}

func TestNativeWrapperRejectsInvalidInstalledImage(t *testing.T) {
	root := os.Getenv("OMPI_TEST_INVALID_IMAGE_ROOT")
	if root != "" {
		executable := filepath.Join(root, "ompi")
		restart := &restartRecord{OperationID: "restart", PreviousInstanceID: strings.Repeat("b", 32)}
		err := execWrapperReplacement(root, executable, protocol.Scope{}, nil, root, filepath.Join(root, "session"), restart, "", nil, nil, false)
		if os.Getenv("OMPI_TEST_INVALID_IMAGE_KIND") == "missing" {
			if !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("missing installed image error = %v, want file not found", err)
			}
		} else if err == nil || !strings.Contains(err.Error(), "not a regular executable file") {
			t.Fatalf("invalid installed image was not rejected explicitly: %v", err)
		}
		if _, err := os.Stat(filepath.Join(root, execStateFilename)); !os.IsNotExist(err) {
			t.Fatalf("invalid installed image wrote restart state: %v", err)
		}
		return
	}

	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"missing", "directory", "nonexecutable", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Chmod(root, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, "ompi")
			var err error
			switch kind {
			case "directory":
				err = os.Mkdir(path, 0700)
			case "nonexecutable":
				err = os.WriteFile(path, []byte("not executable"), 0600)
			case "fifo":
				err = syscall.Mkfifo(path, 0700)
			}
			if err != nil {
				t.Fatal(err)
			}
			// A blocking FIFO open must fail this test instead of hanging the suite.
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			process := exec.CommandContext(ctx, binary, "-test.run=^TestNativeWrapperRejectsInvalidInstalledImage$")
			process.Env = append(os.Environ(), "OMPI_TEST_INVALID_IMAGE_ROOT="+root, "OMPI_TEST_INVALID_IMAGE_KIND="+kind)
			if output, err := process.CombinedOutput(); err != nil {
				t.Fatalf("invalid installed image check failed: %v (context: %v)\n%s", err, ctx.Err(), output)
			}
		})
	}
}

func installedNativeTarget(t *testing.T, executable string) *protocol.NativeTarget {
	t.Helper()
	var info syscall.Stat_t
	if err := syscall.Stat(executable, &info); err != nil {
		t.Fatal(err)
	}
	return &protocol.NativeTarget{
		Device:     strconv.FormatUint(uint64(info.Dev), 10),
		Inode:      strconv.FormatUint(info.Ino, 10),
		Size:       strconv.FormatInt(info.Size, 10),
		ModifiedNs: strconv.FormatInt(info.Mtim.Sec*1e9+info.Mtim.Nsec, 10),
	}
}
