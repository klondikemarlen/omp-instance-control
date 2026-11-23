package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/linux"
	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestDisabledUsageDoesNotCreateStorage(t *testing.T) {
	scope := setUsageEnvironment(t, "true")
	_, err := runControl([]string{"recover", filepath.Join(t.TempDir(), "missing.json")})
	if err == nil || errors.Is(err, errUsage) {
		t.Fatalf("wanted a dispatched but failed recovery, got %v", err)
	}

	assertNoUsageDirectory(t, scope)
}

func TestUsageDoesNotCreateStorageForNonDispatches(t *testing.T) {
	scope := setUsageEnvironment(t, "1")
	for _, args := range [][]string{
		{"--help"},
		{"list", "--version"},
		{"restart", "--help"},
		{"restart", "invalid id"},
		{"work", "--help"},
		{"restore", "--version"},
		{"restore", "import-legacy"},
		{"remove", "arbitrary"},
		{"usage", "--json"},
	} {
		_, _ = runControl(args)
	}

	assertNoUsageDirectory(t, scope)
}

func TestCrossProfileDispatchCountsInInvokingScope(t *testing.T) {
	scope := setUsageEnvironment(t, "1")
	if _, err := runControl([]string{"list", "--profile", "target", "--json"}); err != nil {
		t.Fatal(err)
	}
	target, err := protocol.GetScope("target", "")
	if err != nil {
		t.Fatal(err)
	}

	counts, err := linux.ReadUsage(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 1 || counts[0].Surface != "cli" || counts[0].Feature != "list" || counts[0].Count != 1 {
		t.Fatalf("unexpected invoking-scope counters: %#v", counts)
	}
	assertNoUsageDirectory(t, target)
}

func TestUsageCountsRestoreFeaturesFromParsedGrammar(t *testing.T) {
	scope := setUsageEnvironment(t, "1")
	id := strings.Repeat("a", 32)
	for _, args := range [][]string{
		{"restore"},
		{"restore", "private-name"},
		{"restore", "name", "import-legacy"},
		{"restore", "save", "private-name", "--instance", id},
		{"restore", "slot", id},
		{"restore", "list", "--from", id, "--json"},
		{"restore", "checkpoint"},
		{"restore", "history", "--json"},
		{"restore", "from", id},
		{"restore", "export", "--from=" + id},
	} {
		if _, err := runControl(args); errors.Is(err, errUsage) {
			t.Fatalf("expected command to dispatch for %v: %v", args, err)
		}
	}

	counts, err := linux.ReadUsage(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 9 {
		t.Fatalf("expected fixed restore counters only, got %#v", counts)
	}
	expected := map[string]int64{
		"restore.select":     2,
		"restore.name":       1,
		"restore.save":       1,
		"restore.slot":       1,
		"restore.list":       1,
		"restore.checkpoint": 1,
		"restore.history":    1,
		"restore.from":       1,
		"restore.export":     1,
	}
	for _, row := range counts {
		if row.Surface != "cli" || row.Count != expected[row.Feature] {
			t.Fatalf("unexpected restore usage row: %#v", row)
		}
	}
}

func TestFailedRecoveryAttemptCountsWithoutRecordingPath(t *testing.T) {
	scope := setUsageEnvironment(t, "1")
	_, err := runControl([]string{"recover", filepath.Join(t.TempDir(), "private recovery.json")})
	if err == nil || errors.Is(err, errUsage) {
		t.Fatalf("wanted a dispatched but failed recovery, got %v", err)
	}

	contents, err := os.ReadFile(filepath.Join(scope.AgentDir, "instance-control", "usage-v1", "cli.recover"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(contents, []byte{0}) {
		t.Fatalf("counter must contain only one zero byte, got %q", contents)
	}
}

func TestGuardedWorkDelegationDoesNotCountAsCLIUsage(t *testing.T) {
	scope := setUsageEnvironment(t, "1")
	_, err := runWork(io.Discard, []string{
		"clear",
		"--expect-session-id", "private-session",
		"--expect-session-file", filepath.Join(t.TempDir(), "transcript.jsonl"),
		strings.Repeat("a", 32),
	})
	if err == nil || errors.Is(err, errUsage) {
		t.Fatalf("wanted a dispatched but failed guarded mutation, got %v", err)
	}

	assertNoUsageDirectory(t, scope)
}

func TestUsageReportReadsBothSurfacesIndependentOfOptIn(t *testing.T) {
	scope := setUsageEnvironment(t, "0")
	dir := filepath.Join(scope.AgentDir, "instance-control", "usage-v1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cli.list"), []byte{0, 0}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "slash.restore.list"), []byte{0}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "slash.unknown"), []byte{0}, 0o600); err != nil {
		t.Fatal(err)
	}
	var report bytes.Buffer

	if code, err := runUsage(&report, []string{"--json"}); code != 0 || err != nil {
		t.Fatalf("usage report failed: code=%d err=%v", code, err)
	}
	want := `[{"surface":"cli","feature":"list","count":2},{"surface":"slash","feature":"restore.list","count":1}]` + "\n"
	if report.String() != want {
		t.Fatalf("usage report: got %q, want %q", report.String(), want)
	}
}

func TestEmptyUsageReportExplainsOptIn(t *testing.T) {
	scope := setUsageEnvironment(t, "1")
	var report bytes.Buffer

	if code, err := runUsage(&report, nil); code != 0 || err != nil {
		t.Fatalf("empty usage report failed: code=%d err=%v", code, err)
	}
	if !strings.Contains(report.String(), "OMPI_USAGE=1") {
		t.Fatalf("empty report did not explain opt-in: %q", report.String())
	}
	assertNoUsageDirectory(t, scope)
}

func TestUnavailableUsageStorageDoesNotChangePrimaryCommand(t *testing.T) {
	scope := setUsageEnvironment(t, "1")
	dir := filepath.Join(scope.AgentDir, "instance-control")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "usage-v1"), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	if code, err := runControl([]string{"list", "--json"}); code != 0 || err != nil {
		t.Fatalf("unsafe usage storage affected primary command: code=%d err=%v", code, err)
	}
}

func TestSendMessageStartingWithOptionPrefixIsCounted(t *testing.T) {
	scope := setUsageEnvironment(t, "1")
	if _, err := runControl([]string{"send", "a", "--help"}); errors.Is(err, errUsage) {
		t.Fatalf("literal message was treated as invalid option: %v", err)
	}

	counts, err := linux.ReadUsage(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 1 || counts[0].Feature != "send" || counts[0].Count != 1 {
		t.Fatalf("literal message did not dispatch a send: %#v", counts)
	}
}

func setUsageEnvironment(t *testing.T, optIn string) protocol.Scope {
	t.Helper()
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("OMP_PROFILE", "default")
	t.Setenv("PI_CONFIG_DIR", filepath.Join(root, "config"))
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Join(root, "agent"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "runtime"))
	t.Setenv("OMPI_USAGE", optIn)
	scope, err := protocol.GetScope("", "")
	if err != nil {
		t.Fatal(err)
	}
	return scope
}

func assertNoUsageDirectory(t *testing.T, scope protocol.Scope) {
	t.Helper()
	path := filepath.Join(scope.AgentDir, "instance-control", "usage-v1")
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("usage directory should not exist: %v", err)
	}
}
