package linux

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestConcurrentUsageAppendsOneBytePerInvocation(t *testing.T) {
	scope := protocol.Scope{
		AgentDir: filepath.Join(t.TempDir(), "agent"),
	}
	const attempts = 64
	var writers sync.WaitGroup
	for range attempts {
		writers.Go(func() {
			AppendCLIUsage(scope, "restart")
		})
	}
	writers.Wait()

	dir := filepath.Join(scope.AgentDir, "instance-control", "usage-v1")
	file := filepath.Join(dir, "cli.restart")
	contents, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(contents, make([]byte, attempts)) {
		t.Fatalf("expected %d zero bytes; got %q", attempts, contents)
	}
	for _, name := range []string{dir, file} {
		info, err := os.Stat(name)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("counter storage is accessible to other users: %s %s", name, info.Mode())
		}
	}
}

func TestUnknownUsageFeatureCreatesNoStorage(t *testing.T) {
	scope := protocol.Scope{
		AgentDir: filepath.Join(t.TempDir(), "agent"),
	}
	AppendCLIUsage(scope, "../untrusted")

	if _, err := os.Lstat(scope.AgentDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unknown feature created storage: %v", err)
	}
}

func TestUsageRefusesSymlinkedDirectoryComponents(t *testing.T) {
	for _, component := range []string{"agent", "instance-control", "usage-v1"} {
		t.Run(component, func(t *testing.T) {
			root := t.TempDir()
			scope := protocol.Scope{
				AgentDir: filepath.Join(root, "agent"),
			}
			var link string
			switch component {
			case "agent":
				link = scope.AgentDir
			case "instance-control":
				link = filepath.Join(scope.AgentDir, component)
			case "usage-v1":
				link = filepath.Join(scope.AgentDir, "instance-control", component)
			}
			if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
				t.Fatal(err)
			}
			target := t.TempDir()
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}

			AppendCLIUsage(scope, "list")

			entries, err := os.ReadDir(target)
			if err != nil || len(entries) != 0 {
				t.Fatalf("symlink target changed: %v %v", entries, err)
			}
			if _, err := ReadUsage(scope); err == nil {
				t.Fatal("report accepted a symlinked directory component")
			}
		})
	}
}

func TestUsageRejectsNonPrivateCounterStorage(t *testing.T) {
	for _, scenario := range []string{"symlink", "hardlink", "FIFO", "public file"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			scope := protocol.Scope{
				AgentDir: filepath.Join(root, "agent"),
			}
			dir := filepath.Join(scope.AgentDir, "instance-control", "usage-v1")
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(dir, "cli.send")
			preserved := filepath.Join(root, "preserved")
			if err := os.WriteFile(preserved, []byte("keep"), 0o600); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "symlink":
				if err := os.Symlink(preserved, file); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				if err := os.Link(preserved, file); err != nil {
					t.Fatal(err)
				}
			case "FIFO":
				if err := syscall.Mkfifo(file, 0o600); err != nil {
					t.Fatal(err)
				}
			case "public file":
				if err := os.Rename(preserved, file); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(file, 0o644); err != nil {
					t.Fatal(err)
				}
				preserved = file
			}

			AppendCLIUsage(scope, "send")

			contents, err := os.ReadFile(preserved)
			if err != nil || string(contents) != "keep" {
				t.Fatalf("unsafe counter changed existing data: %q %v", contents, err)
			}
			if _, err := ReadUsage(scope); err == nil {
				t.Fatal("report accepted unsafe counter storage")
			}
		})
	}
}

func TestUsageRefusesPublicDirectoryWithoutChangingModes(t *testing.T) {
	scope := protocol.Scope{
		AgentDir: filepath.Join(t.TempDir(), "agent"),
	}
	dir := filepath.Join(scope.AgentDir, "instance-control", "usage-v1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	AppendCLIUsage(scope, "list")

	info, err := os.Stat(dir)
	if err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("usage modified existing directory permissions: %v %v", info, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("usage wrote into a public directory: %v %v", entries, err)
	}
}
