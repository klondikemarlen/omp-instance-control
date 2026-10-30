package linux

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestCaptureRecoveryCheckpointIncludesOnlyMatchingManagedSlots(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "runtime"))
	scope, first := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	second := first
	second.RestoreID = strings.Repeat("b", 32)
	second.SessionID = "other-session"
	writeRestoreFixtureSnapshot(t, scope, second)
	third := first
	third.RestoreID = strings.Repeat("c", 32)
	third.SessionID = "file-mismatch-session"
	third.SessionFile = filepath.Join(scope.AgentDir, "sessions", "file-mismatch.jsonl")
	if err := os.WriteFile(third.SessionFile, []byte("persisted session\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeRestoreFixtureSnapshot(t, scope, third)
	transport, err := NewTransport(scope)
	if err != nil {
		t.Fatal(err)
	}

	matching := testRecord(scope, strings.Repeat("1", 32))
	matching.RestoreID = first.RestoreID
	matching.SessionID = first.SessionID
	matching.CWD = first.CWD
	matching.SessionFile = stringPointer(first.SessionFile)
	duplicate := matching
	duplicate.InstanceID = strings.Repeat("5", 32)
	divergent := testRecord(scope, strings.Repeat("2", 32))
	divergent.RestoreID = second.RestoreID
	divergent.SessionID = "newer-record-session"
	divergent.CWD = second.CWD
	divergent.SessionFile = stringPointer(second.SessionFile)
	fileMismatch := testRecord(scope, strings.Repeat("3", 32))
	fileMismatch.RestoreID = third.RestoreID
	fileMismatch.SessionID = third.SessionID
	fileMismatch.CWD = third.CWD
	fileMismatch.SessionFile = stringPointer(first.SessionFile)
	unmanaged := testRecord(scope, strings.Repeat("4", 32))
	unmanaged.LauncherManaged = false
	unmanaged.RestoreID = strings.Repeat("d", 32)
	for _, record := range []protocol.Record{matching, duplicate, divergent, fileMismatch, unmanaged} {
		if err := WritePrivateJSON(filepath.Join(transport.directory, record.InstanceID+".json"), record); err != nil {
			t.Fatal(err)
		}
	}

	checkpoint, err := CaptureRecoveryCheckpoint(scope, "automatic", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(checkpoint.Entries) != 1 || checkpoint.Entries[0].RestoreID != first.RestoreID {
		t.Fatalf("checkpoint included a divergent or unmanaged slot: %#v", checkpoint.Entries)
	}

	excluded, err := CaptureRecoveryCheckpoint(scope, "automatic", first.RestoreID)
	if err != nil {
		t.Fatal(err)
	}
	if len(excluded.Entries) != 0 {
		t.Fatalf("graceful-shutdown checkpoint retained the closing slot: %#v", excluded.Entries)
	}
}

func TestCaptureRecoveryCheckpointSkipsManagedSlotsWithoutSnapshots(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "runtime"))
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	transport, err := NewTransport(scope)
	if err != nil {
		t.Fatal(err)
	}
	record := testRecord(scope, strings.Repeat("4", 32))
	record.RestoreID = strings.Repeat("d", 32)
	record.SessionID = "not-yet-materialized"
	record.CWD = filepath.Join(filepath.Dir(scope.AgentDir), "project")
	if err := WritePrivateJSON(filepath.Join(transport.directory, record.InstanceID+".json"), record); err != nil {
		t.Fatal(err)
	}

	checkpoint, err := CaptureRecoveryCheckpoint(scope, "manual", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(checkpoint.Entries) != 0 {
		t.Fatalf("checkpoint included an unmaterialized managed slot: %#v", checkpoint.Entries)
	}
}

func TestListRecoverySessionsRestrictsExplicitCheckpointAndKeepsEmptyMembership(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	firstID := strings.Repeat("a", 32)
	secondID := strings.Repeat("b", 32)
	scope, first := newRestoreFixture(t, firstID, stoppedRestoreOwner())
	second := first
	second.RestoreID = secondID
	second.SessionID = "second-session"
	writeRestoreFixtureSnapshot(t, scope, second)
	if err := SaveRestoreName(scope, "second", secondID); err != nil {
		t.Fatal(err)
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := protocol.RecoveryCheckpoint{
		Version: 1, CheckpointID: strings.Repeat("c", 32), Scope: scope,
		BootID: "00000000-0000-4000-8000-000000000000", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Reason: "manual", Entries: []protocol.RecoveryCheckpointEntry{{
			RestoreID: firstID, SessionID: first.SessionID, CWD: first.CWD,
		}},
	}
	if err := publishImmutableRecoveryCheckpoint(directories, checkpoint); err != nil {
		t.Fatal(err)
	}

	explicit, err := ListRecoverySessions(scope, checkpoint.CheckpointID)
	if err != nil {
		t.Fatal(err)
	}
	if len(explicit) != 1 || explicit[0].RestoreID != firstID {
		t.Fatalf("explicit checkpoint included a named slot outside its membership: %#v", explicit)
	}
	defaultCandidates, err := ListRecoverySessions(scope, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(defaultCandidates) != 2 || defaultCandidates[0].RestoreID != firstID || defaultCandidates[1].RestoreID != secondID || defaultCandidates[1].Name != "second" {
		t.Fatalf("default recovery candidates did not merge checkpoint membership and named slots: %#v", defaultCandidates)
	}

	empty := checkpoint
	empty.CheckpointID = strings.Repeat("e", 32)
	empty.CreatedAt = time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	empty.Entries = []protocol.RecoveryCheckpointEntry{}
	if err := publishImmutableRecoveryCheckpoint(directories, empty); err != nil {
		t.Fatal(err)
	}
	selected, err := ListRecoverySessions(scope, empty.CheckpointID)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 0 {
		t.Fatalf("empty explicit checkpoint fell back to another conversation: %#v", selected)
	}
}

func TestListRecoverySessionsDiscoversUncheckpointedSnapshots(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("f", 32), stoppedRestoreOwner())
	candidates, err := ListRecoverySessions(scope, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].RestoreID != session.RestoreID || candidates[0].Session == nil {
		t.Fatalf("legacy 0.9.3 snapshot was not discovered without a name: %#v", candidates)
	}
}

func TestRecoveryCandidatesQuietlyMarkMissingPathsAndRejectSymlinks(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	missingFile := filepath.Join(scope.AgentDir, "sessions", "not-yet-written.jsonl")
	session.SessionFile = missingFile
	writeRestoreFixtureSnapshot(t, scope, session)
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := protocol.RecoveryCheckpoint{
		Version: 1, CheckpointID: strings.Repeat("c", 32), Scope: scope,
		BootID: "00000000-0000-4000-8000-000000000000", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Reason: "manual", Entries: []protocol.RecoveryCheckpointEntry{{RestoreID: session.RestoreID, SessionID: session.SessionID, CWD: session.CWD}},
	}
	if err := publishImmutableRecoveryCheckpoint(directories, checkpoint); err != nil {
		t.Fatal(err)
	}
	candidates, err := ListRecoverySessions(scope, checkpoint.CheckpointID)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].Session != nil || candidates[0].Unavailable != missingRecoveryPathReason {
		t.Fatalf("missing transcript was not represented as an unavailable candidate: %#v", candidates)
	}

	target := filepath.Join(scope.AgentDir, "sessions", "real.jsonl")
	if err := os.WriteFile(target, []byte("persisted\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, missingFile); err != nil {
		t.Fatal(err)
	}
	writeRestoreFixtureSnapshot(t, scope, session)
	if _, err := ListRecoverySessions(scope, checkpoint.CheckpointID); err == nil {
		t.Fatal("symlinked transcript was downgraded to an unavailable row")
	}
}

func TestRecoveryCheckpointPruningKeepsTenNewestAndPreviousBoot(t *testing.T) {
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	currentBoot, err := readBootID()
	if err != nil {
		t.Fatal(err)
	}
	previousBoot := "00000000-0000-4000-8000-000000000000"
	if previousBoot == currentBoot {
		previousBoot = "ffffffff-ffff-4fff-8fff-ffffffffffff"
	}
	baseTime := time.Now().UTC().Add(-time.Hour)
	for index := range 12 {
		checkpoint := protocol.RecoveryCheckpoint{
			Version: 1, CheckpointID: fmt.Sprintf("%032x", index+1), Scope: scope,
			BootID: currentBoot, CreatedAt: baseTime.Add(time.Duration(index) * time.Minute).Format(time.RFC3339Nano),
			Reason: "automatic", Entries: []protocol.RecoveryCheckpointEntry{},
		}
		if err := publishImmutableRecoveryCheckpoint(directories, checkpoint); err != nil {
			t.Fatal(err)
		}
	}
	protected := protocol.RecoveryCheckpoint{
		Version: 1, CheckpointID: strings.Repeat("f", 32), Scope: scope,
		BootID: previousBoot, CreatedAt: baseTime.Add(-time.Hour).Format(time.RFC3339Nano),
		Reason: "automatic", Entries: []protocol.RecoveryCheckpointEntry{},
	}
	if err := publishImmutableRecoveryCheckpoint(directories, protected); err != nil {
		t.Fatal(err)
	}

	if err := pruneRecoveryCheckpoints(scope, currentBoot); err != nil {
		t.Fatal(err)
	}
	checkpoints, err := ListRecoveryCheckpoints(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(checkpoints) != 11 {
		t.Fatalf("retained checkpoint count = %d, want 11", len(checkpoints))
	}
	foundProtected := false
	for _, checkpoint := range checkpoints {
		if checkpoint.CheckpointID == protected.CheckpointID {
			foundProtected = true
		}
		if checkpoint.BootID == currentBoot && checkpoint.CreatedAt < baseTime.Add(2*time.Minute).Format(time.RFC3339Nano) {
			t.Fatalf("old current-boot checkpoint survived pruning: %#v", checkpoint)
		}
	}
	if !foundProtected {
		t.Fatal("newest different-boot checkpoint was not protected")
	}
}

func TestSlotRestoreRejectsChangedSelectedWorkButAllowsOwnerRefresh(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	changed := session
	changed.SessionID = "different-session"
	changed.UpdatedAt = time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	writeRestoreFixtureSnapshot(t, scope, changed)
	launches := 0
	_, err := restoreSessionSlotExpected(scope, session.RestoreID, filepath.Join(t.TempDir(), "extension.js"), session, true,
		func([]string, string, string, *os.File) (int, error) {
			launches++
			return 0, nil
		})
	if err == nil || !strings.Contains(err.Error(), "changed after confirmation") || launches != 0 {
		t.Fatalf("changed selected slot launched or returned an unclear error: err=%v launches=%d", err, launches)
	}

	unchanged := session
	unchanged.Owner.StartTime = "2"
	unchanged.UpdatedAt = time.Now().UTC().Add(2 * time.Second).Format(time.RFC3339Nano)
	writeRestoreFixtureSnapshot(t, scope, unchanged)
	_, err = restoreSessionSlotExpected(scope, session.RestoreID, filepath.Join(t.TempDir(), "extension.js"), session, true,
		func([]string, string, string, *os.File) (int, error) {
			launches++
			return 0, nil
		})
	if err != nil || launches != 1 {
		t.Fatalf("safe owner metadata refresh changed the selected work identity: err=%v launches=%d", err, launches)
	}
}

func TestNamedRestoreRejectsChangedSelectedWorkAfterBindingRecheck(t *testing.T) {
	scope, selected := newRestoreFixture(t, strings.Repeat("b", 32), stoppedRestoreOwner())
	if err := SaveRestoreName(scope, "work", selected.RestoreID); err != nil {
		t.Fatal(err)
	}
	current := selected
	current.CWD = filepath.Join(filepath.Dir(selected.CWD), "another-project")
	if err := os.Mkdir(current.CWD, 0o700); err != nil {
		t.Fatal(err)
	}
	current.UpdatedAt = time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	writeRestoreFixtureSnapshot(t, scope, current)
	launches := 0
	_, err := restoreNamedSessionWithExpected(scope, "work", filepath.Join(t.TempDir(), "extension.js"), &selected, true,
		func([]string, string, string, *os.File) (int, error) {
			launches++
			return 0, nil
		})
	if err == nil || !strings.Contains(err.Error(), "changed after confirmation") || launches != 0 {
		t.Fatalf("named restore launched changed work or returned an unclear error: err=%v launches=%d", err, launches)
	}
}

func TestRecoveryCheckpointRejectsCrossScopeAndUnsafeFiles(t *testing.T) {
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	checkpoints, err := ListRecoveryCheckpoints(scope)
	if err != nil || len(checkpoints) != 0 {
		t.Fatalf("empty checkpoint history = %#v, %v", checkpoints, err)
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := protocol.RecoveryCheckpoint{
		Version: 1, CheckpointID: strings.Repeat("c", 32), Scope: scope,
		BootID: "00000000-0000-4000-8000-000000000000", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Reason: "manual", Entries: []protocol.RecoveryCheckpointEntry{},
	}
	wrongScope := checkpoint
	wrongScope.Scope.Profile = "other"
	if err := publishImmutableRecoveryCheckpoint(directories, wrongScope); err != nil {
		t.Fatal(err)
	}
	if _, err := ListRecoveryCheckpoints(scope); err == nil || !strings.Contains(err.Error(), "scope does not match") {
		t.Fatalf("cross-scope checkpoint was accepted: %v", err)
	}
	file := filepath.Join(directories.checkpoints, strings.Repeat("d", 32)+".json")
	if err := os.Symlink(filepath.Join(t.TempDir(), "unrelated.json"), file); err != nil {
		t.Fatal(err)
	}
	if _, err := readRecoveryCheckpoint(directories, scope, strings.Repeat("d", 32)); err == nil || errors.Is(err, os.ErrNotExist) {
		t.Fatalf("symlink checkpoint was followed or treated as missing: %v", err)
	}
}

func TestRecoveryCheckpointPublicationIsPrivateAndImmutable(t *testing.T) {
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := protocol.RecoveryCheckpoint{
		Version: 1, CheckpointID: strings.Repeat("e", 32), Scope: scope,
		BootID: "00000000-0000-4000-8000-000000000000", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Reason: "manual", Entries: []protocol.RecoveryCheckpointEntry{},
	}
	if err := publishImmutableRecoveryCheckpoint(directories, checkpoint); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(directories.checkpoints, checkpoint.CheckpointID+".json")
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("checkpoint mode = %04o, want 0600", info.Mode().Perm())
	}
	replacement := checkpoint
	replacement.Reason = "automatic"
	if err := publishImmutableRecoveryCheckpoint(directories, replacement); !errors.Is(err, os.ErrExist) {
		t.Fatalf("checkpoint publication overwrote an immutable ID: %v", err)
	}
	stored, err := readRecoveryCheckpoint(directories, scope, checkpoint.CheckpointID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Reason != "manual" {
		t.Fatalf("checkpoint content changed after colliding publication: %#v", stored)
	}
}

func TestDefaultRecoveryCheckpointPreservesMeaningfulEmptySets(t *testing.T) {
	currentBoot := "00000000-0000-4000-8000-000000000000"
	oldBoot := "00000000-0000-4000-8000-000000000001"
	member := []protocol.RecoveryCheckpointEntry{{RestoreID: strings.Repeat("d", 32)}}
	for _, scenario := range []struct {
		name              string
		current, previous []protocol.RecoveryCheckpointEntry
		expected          string
	}{
		{"empty previous boot does not mask current sessions", member, nil, "current"},
		{"previous boot sessions remain recoverable", member, member, "previous"},
		{"normal exit does not resurrect previous sessions", nil, member, "current"},
		{"all empty stays empty", nil, nil, "current"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			checkpoints := []protocol.RecoveryCheckpoint{
				{CheckpointID: "current", BootID: currentBoot, Reason: "automatic", Entries: scenario.current},
				{CheckpointID: "legacy", BootID: "legacy", Reason: "legacy", Entries: member},
				{CheckpointID: "previous", BootID: oldBoot, Reason: "automatic", Entries: scenario.previous},
				{CheckpointID: "older", BootID: oldBoot, Reason: "automatic", Entries: member},
			}
			selected := defaultRecoveryCheckpoint(checkpoints, currentBoot)
			if selected == nil || selected.CheckpointID != scenario.expected {
				t.Fatalf("selected %#v, want %s", selected, scenario.expected)
			}
		})
	}
}

func TestAutomaticRecoveryCheckpointDeduplicatesMembershipOnly(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "runtime"))
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	first, err := CaptureRecoveryCheckpoint(scope, "automatic", "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := CaptureRecoveryCheckpoint(scope, "automatic", "")
	if err != nil {
		t.Fatal(err)
	}
	if second.CheckpointID != first.CheckpointID {
		t.Fatalf("unchanged automatic capture created checkpoint %s after %s", second.CheckpointID, first.CheckpointID)
	}
	manual, err := CaptureRecoveryCheckpoint(scope, "manual", "")
	if err != nil {
		t.Fatal(err)
	}
	if manual.CheckpointID == first.CheckpointID {
		t.Fatal("manual capture was deduplicated")
	}
}
func TestListRecoverySessionsDoesNotLetEmptyPreviousBootMaskCurrentSessions(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(root, "runtime"))
	scope, session := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	currentBoot, err := readBootID()
	if err != nil {
		t.Fatal(err)
	}
	old := protocol.RecoveryCheckpoint{
		Version: 1, CheckpointID: strings.Repeat("b", 32), Scope: scope,
		BootID:    "00000000-0000-4000-8000-000000000001",
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Reason: "automatic",
		Entries: []protocol.RecoveryCheckpointEntry{},
	}
	current := old
	current.CheckpointID = strings.Repeat("c", 32)
	current.BootID = currentBoot
	current.CreatedAt = time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	current.Entries = []protocol.RecoveryCheckpointEntry{{RestoreID: session.RestoreID, SessionID: session.SessionID, CWD: session.CWD}}
	for _, checkpoint := range []protocol.RecoveryCheckpoint{old, current} {
		if err := publishImmutableRecoveryCheckpoint(directories, checkpoint); err != nil {
			t.Fatal(err)
		}
	}
	candidates, err := ListRecoverySessions(scope, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].RestoreID != session.RestoreID {
		t.Fatalf("empty previous boot hid current recovery candidates: %#v", candidates)
	}
	selected, err := ListRecoverySessions(scope, old.CheckpointID)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 0 {
		t.Fatalf("explicit empty checkpoint exposed unrelated recovery candidates: %#v", selected)
	}
}

func TestConcurrentRecoveryCapturesRetainBoundedReadableHistory(t *testing.T) {
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(filepath.Dir(scope.AgentDir), "runtime"))
	const workers = 6
	const capturesPerWorker = 12
	results := make(chan error, workers*capturesPerWorker)
	for range workers {
		go func() {
			for range capturesPerWorker {
				_, err := CaptureRecoveryCheckpoint(scope, "manual", "")
				results <- err
			}
		}()
	}

	var firstFailure error
	for range workers * capturesPerWorker {
		if err := <-results; err != nil && firstFailure == nil {
			firstFailure = err
		}
	}
	if firstFailure != nil {
		t.Fatalf("concurrent checkpoint publication or pruning failed: %v", firstFailure)
	}
	checkpoints, err := ListRecoveryCheckpoints(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(checkpoints) != 10 {
		t.Fatalf("concurrent captures retained %d checkpoints, want 10", len(checkpoints))
	}
}

func TestConcurrentAutomaticCapturesPublishOneMembershipTransition(t *testing.T) {
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(filepath.Dir(scope.AgentDir), "runtime"))
	const workers = 12
	results := make(chan protocol.RecoveryCheckpoint, workers)
	failures := make(chan error, workers)
	for range workers {
		go func() {
			checkpoint, err := CaptureRecoveryCheckpoint(scope, "automatic", "")
			results <- checkpoint
			failures <- err
		}()
	}
	var identity string
	for range workers {
		checkpoint := <-results
		if err := <-failures; err != nil {
			t.Fatal(err)
		}
		if identity == "" {
			identity = checkpoint.CheckpointID
		}
		if checkpoint.CheckpointID != identity {
			t.Fatalf("unchanged concurrent membership created different checkpoints: %s, %s", identity, checkpoint.CheckpointID)
		}
	}
	history, err := ListRecoveryCheckpoints(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].CheckpointID != identity {
		t.Fatalf("concurrent captures filled history: %#v", history)
	}
}
