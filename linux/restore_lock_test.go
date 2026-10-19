package linux

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRestoreLockSurvivesLauncherDeathUntilChildExit(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("8", 32), stoppedRestoreOwner())
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(directories.root, "child-ready")
	release := filepath.Join(directories.root, "release-child")
	parentClosed := filepath.Join(directories.root, "parent-closed")
	helper := exec.Command(os.Args[0], "-test.run=^TestRestoreLockProcessHelper$")
	helper.Env = append(os.Environ(),
		"OMPI_TEST_RESTORE_LOCK_DIR="+directories.snapshots,
		"OMPI_TEST_RESTORE_LOCK_ID="+session.RestoreID,
	)
	helper.Stdout, helper.Stderr = os.Stdout, os.Stderr
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.WriteFile(release, nil, 0o600)
		if helper.ProcessState == nil {
			_ = helper.Process.Kill()
			_ = helper.Wait()
		}
	})
	waitForRestoreTestFile(t, ready)
	waitForRestoreTestFile(t, parentClosed)
	if err := helper.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := helper.Wait(); err == nil {
		t.Fatal("fixture launcher did not terminate abruptly")
	}

	lockPath := filepath.Join(directories.snapshots, session.RestoreID+".lock")
	probe, err := os.OpenFile(lockPath, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	if err := syscall.Flock(int(probe.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); !errors.Is(err, syscall.EWOULDBLOCK) {
		t.Fatalf("a surviving child lost the slot lock after its launcher closed and died: %v", err)
	}
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := syscall.Flock(int(probe.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) || time.Now().After(deadline) {
			t.Fatalf("slot lock was not released after the child exited: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRestoreLockProcessHelper(t *testing.T) {
	directory := os.Getenv("OMPI_TEST_RESTORE_LOCK_DIR")
	if directory == "" {
		return
	}
	directories := restoreDirectories{snapshots: directory}
	lock, err := lockRestoreSnapshot(directories, os.Getenv("OMPI_TEST_RESTORE_LOCK_ID"))
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Dir(directory)
	ready := filepath.Join(root, "child-ready")
	release := filepath.Join(root, "release-child")
	childDone := make(chan error, 1)
	go func() {
		result, err := runChild("/bin/sh", []string{
			"-c", `printf '%s' "$$" > "$1"; while [ ! -f "$2" ]; do /bin/sleep 0.01; done`,
			"restore-lock-fixture", ready, release,
		}, root, os.Environ(), make(chan os.Signal), []*os.File{lock})
		if err == nil && result.code != 0 {
			err = errors.New("lock fixture child exited unsuccessfully")
		}
		childDone <- err
	}()
	waitForRestoreTestFile(t, ready)
	closeRestoreLock(lock)
	if err := os.WriteFile(filepath.Join(root, "parent-closed"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := <-childDone; err != nil {
		t.Fatal(err)
	}
}

func TestRestoreMetadataFIFOIsRejectedWithoutBlocking(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("9", 32), stoppedRestoreOwner())
	file := filepath.Join(scope.AgentDir, "instance-control", "restore", "snapshots", session.RestoreID+".json")
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(file, 0o600); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		var value any
		result <- readRestoreJSON(file, &value)
	}()
	select {
	case err := <-result:
		if err == nil || !strings.Contains(err.Error(), "unsafe") {
			t.Fatalf("FIFO metadata was not rejected as unsafe: %v", err)
		}
	case <-time.After(2 * time.Second):
		writer, _ := os.OpenFile(file, os.O_RDWR|syscall.O_NONBLOCK, 0)
		if writer != nil {
			defer writer.Close()
		}
		t.Fatal("restore metadata open blocked on a FIFO")
	}
}

func waitForRestoreTestFile(t *testing.T, file string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(file); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("fixture did not reach its file barrier: %s", file)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
