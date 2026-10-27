package linux

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestWrapperRestartHarness(t *testing.T) {
	phase := os.Getenv("OMPI_TEST_WRAPPER_PHASE")
	if phase == "" {
		t.Skip("helper process only")
	}
	stdinIsTerminal = func() bool { return true }
	stdoutIsTerminal = func() bool { return true }
	os.Args[0] = os.Getenv("OMPI_TEST_WRAPPER_PATH")
	var args []string
	if phase == "original" {
		args = []string{"--profile", "work", "--config", "settings.json", "initial prompt"}
	}
	code, err := Launch(args, filepath.Join(os.Getenv("OMPI_TEST_ROOT"), "adapter.js"), "test")
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
	marker := filepath.Join(root, "replacement-executed")
	if err := os.WriteFile(installed, []byte("old executable"), 0700); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nprintf replacement > " + shellQuote(marker) + "\n" +
		"export OMPI_TEST_WRAPPER_PHASE=replacement\nexec " + shellQuote(binary) +
		" -test.run=^TestWrapperRestartHarness$\n"
	if err := os.WriteFile(updated, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OMPI_TEST_ROOT", root)
	t.Setenv("OMPI_TEST_WRAPPER_PHASE", "original")
	t.Setenv("OMPI_TEST_WRAPPER_PATH", installed)
	t.Setenv("OMPI_TEST_WRAPPER_REPLACEMENT", updated)
	t.Setenv("OMPI_TEST_RESTART_WRAPPER", "1")
	t.Setenv("OMPI_TEST_CHECK_LOCK", "1")
	process := exec.Command(binary, "-test.run=^TestWrapperRestartHarness$")
	process.Dir = root
	if output, err := process.CombinedOutput(); err != nil {
		t.Fatalf("wrapper replacement failed: %v\n%s", err, output)
	}
	if contents, err := os.ReadFile(marker); err != nil || string(contents) != "replacement" {
		t.Fatalf("installed replacement code did not execute: %q %v", contents, err)
	}
	calls := readInvocations(t, logPath)
	if len(calls) != 2 {
		t.Fatalf("wrapper replacement launched %d OMP children, want two", len(calls))
	}
	first, second := calls[0], calls[1]
	if first.Token == second.Token || first.Launch["restoreId"] != second.Launch["restoreId"] ||
		!reflect.DeepEqual(first.Launch["scope"], second.Launch["scope"]) {
		t.Fatalf("replacement lost launch identity or scope: first=%#v second=%#v", first, second)
	}
	if second.CWD != cwd || !containsPair(second.Args, "-r", session) ||
		!containsPair(second.Args, "--config", filepath.Join(root, "settings.json")) || contains(second.Args, "initial prompt") {
		t.Fatalf("replacement changed current session/cwd/arguments: %#v", second)
	}
	correlation := second.Launch["lastRestart"].(map[string]any)
	if correlation["operationId"] != "operation-123" || correlation["previousInstanceId"] != "00000000000000000000000000000001" {
		t.Fatalf("replacement lost restart correlation: %#v", correlation)
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
	err = execWrapperReplacement(root, executable, scope, []string{}, root, filepath.Join(root, "session.jsonl"), restart, restoreID, lock, nil)
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

func TestPinnedNativeTargetRejectsMismatchedImage(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "ompi")
	if err := os.WriteFile(executable, []byte("candidate A"), 0700); err != nil {
		t.Fatal(err)
	}
	restart := &restartRecord{OperationID: "restart", PreviousInstanceID: strings.Repeat("b", 32)}
	called := false
	originalExec := execWrapperProcess
	execWrapperProcess = func(string, []string, []string) error {
		called = true
		return nil
	}
	t.Cleanup(func() { execWrapperProcess = originalExec })
	target := &protocol.NativeTarget{Device: "0", Inode: "1", Size: "11", ModifiedNs: "0"}
	err := execWrapperReplacement(root, executable, protocol.Scope{}, nil, root, filepath.Join(root, "session"), restart, "", nil, target)
	if err == nil || !strings.Contains(err.Error(), "changed after verification") {
		t.Fatalf("mismatched installed image was not rejected explicitly: %v", err)
	}
	if called {
		t.Fatal("mismatched installed image reached exec")
	}
	if _, err := os.Stat(filepath.Join(root, execStateFilename)); !os.IsNotExist(err) {
		t.Fatalf("mismatched image wrote restart state: %v", err)
	}
}

func TestPinnedNativeTargetReplacementHarness(t *testing.T) {
	if os.Getenv("OMPI_TEST_PINNED_EXEC") != "1" {
		t.Skip("helper process only")
	}
	root := os.Getenv("OMPI_TEST_PINNED_ROOT")
	executable := filepath.Join(root, "ompi")
	replacement := filepath.Join(root, "replacement")
	marker := filepath.Join(root, "executed")
	if os.Getenv("OMPI_TEST_PINNED_COMPLETE") == "1" {
		if err := os.WriteFile(marker, []byte("pinned"), 0600); err != nil {
			t.Fatal(err)
		}
		return
	}
	var info syscall.Stat_t
	if err := syscall.Stat(executable, &info); err != nil {
		t.Fatal(err)
	}
	target := &protocol.NativeTarget{
		Device:     strconv.FormatUint(uint64(info.Dev), 10),
		Inode:      strconv.FormatUint(info.Ino, 10),
		Size:       strconv.FormatInt(info.Size, 10),
		ModifiedNs: strconv.FormatInt(info.Mtim.Sec*1e9+info.Mtim.Nsec, 10),
	}
	originalExec := execWrapperProcess
	execWrapperProcess = func(path string, _ []string, _ []string) error {
		if err := os.Rename(replacement, executable); err != nil {
			return err
		}
		return syscall.Exec(path, []string{executable, "-test.run=^TestPinnedNativeTargetReplacementHarness$"}, append(os.Environ(), "OMPI_TEST_PINNED_COMPLETE=1"))
	}
	defer func() { execWrapperProcess = originalExec }()
	restart := &restartRecord{OperationID: "restart", PreviousInstanceID: strings.Repeat("b", 32)}
	if err := execWrapperReplacement(root, executable, protocol.Scope{}, nil, root, filepath.Join(root, "session"), restart, "", nil, target); err != nil {
		t.Fatal(err)
	}
	t.Fatal("native replacement returned without executing")
}

func TestPinnedNativeTargetSurvivesAtomicPathReplacement(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(root, "ompi")
	replacement := filepath.Join(root, "replacement")
	contents, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(installed, contents, 0700); err != nil {
		t.Fatal(err)
	}
	replacementBytes, err := os.ReadFile("/bin/false")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(replacement, replacementBytes, 0700); err != nil {
		t.Fatal(err)
	}
	process := exec.Command(executable, "-test.run=^TestPinnedNativeTargetReplacementHarness$")
	process.Env = append(os.Environ(), "OMPI_TEST_PINNED_EXEC=1", "OMPI_TEST_PINNED_ROOT="+root)
	if output, err := process.CombinedOutput(); err != nil {
		t.Fatalf("pinned native replacement failed: %v\n%s", err, output)
	}
	if contents, err := os.ReadFile(filepath.Join(root, "executed")); err != nil || string(contents) != "pinned" {
		t.Fatalf("the pinned image did not run after atomic replacement: %q %v", contents, err)
	}
}
