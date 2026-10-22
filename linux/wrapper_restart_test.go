package linux

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
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
	code, err := Launch(args, filepath.Join(os.Getenv("OMPI_TEST_ROOT"), "adapter.js"))
	if err != nil || code != 0 {
		t.Fatalf("native wrapper returned code=%d err=%v", code, err)
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
	err = execWrapperReplacement(root, executable, scope, []string{}, root, filepath.Join(root, "session.jsonl"), restart, restoreID, lock)
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
