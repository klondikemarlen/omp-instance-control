package linux

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestImportLegacyRecoveryParsesQuotedCommandsIdempotently(t *testing.T) {
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	cwd := filepath.Join(filepath.Dir(scope.AgentDir), "project's work")
	if err := os.Mkdir(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	transcript := writeLegacyTranscript(t, scope, filepath.Join("nested", "one.jsonl"), "legacy-id")
	source := filepath.Join(t.TempDir(), "snapshot.txt")
	contents := fmt.Sprintf("cd %s && omp --resume %s\n", shellQuote(cwd), shellQuote("legacy-id"))
	if err := os.WriteFile(source, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}

	first, err := ImportLegacyRecovery(scope, source)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ImportLegacyRecovery(scope, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 || len(second) != 1 || first[0].CheckpointID != second[0].CheckpointID {
		t.Fatalf("same source did not import idempotently: first=%#v second=%#v", first, second)
	}
	if first[0].BootID != "legacy" || first[0].Reason != "legacy" || len(first[0].Entries) != 0 || len(first[0].Legacy) != 1 {
		t.Fatalf("legacy source was represented as managed ownership: %#v", first[0])
	}
	entry := first[0].Legacy[0]
	if entry.CWD != cwd || entry.SessionID != "legacy-id" || entry.SessionFile != transcript || entry.Unavailable != "" {
		t.Fatalf("quoted legacy command did not resolve to its exact transcript: %#v", entry)
	}
	stored, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) != string(original) {
		t.Fatalf("legacy source was modified during import: %q", stored)
	}

	copyPath := filepath.Join(filepath.Dir(source), "copy.txt")
	if err := os.WriteFile(copyPath, original, 0o600); err != nil {
		t.Fatal(err)
	}
	copied, err := ImportLegacyRecovery(scope, copyPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(copied) != 1 || copied[0].CheckpointID == first[0].CheckpointID {
		t.Fatalf("identical content at a different path reused an import identity: %#v", copied)
	}
	if err := os.WriteFile(source, append(original, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	changed, err := ImportLegacyRecovery(scope, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 1 || changed[0].CheckpointID == first[0].CheckpointID {
		t.Fatalf("changed source content reused an import identity: %#v", changed)
	}

	selected, err := ListRecoverySessions(scope, first[0].CheckpointID)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 1 || selected[0].Legacy == nil || selected[0].RestoreID != "" || selected[0].Session != nil {
		t.Fatalf("legacy checkpoint was exposed as an automatic managed slot: %#v", selected)
	}
	defaultCandidates, err := ListRecoverySessions(scope, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range defaultCandidates {
		if candidate.Legacy != nil {
			t.Fatalf("default recovery selected a legacy item without explicit selection: %#v", candidate)
		}
	}
}

func TestImportLegacyRecoveryReportsMissingAmbiguousCrossScopeAndUnsupportedCommands(t *testing.T) {
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	writeLegacyTranscript(t, scope, "first.jsonl", "duplicate-id")
	writeLegacyTranscript(t, scope, "second.jsonl", "duplicate-id")
	otherScope, _ := newRestoreFixture(t, strings.Repeat("b", 32), stoppedRestoreOwner())
	writeLegacyTranscript(t, otherScope, "foreign.jsonl", "foreign-scope-id")
	source := filepath.Join(t.TempDir(), "active-sessions.txt")
	contents := strings.Join([]string{
		fmt.Sprintf("cd %s && omp --resume %s", shellQuote("/work"), shellQuote("duplicate-id")),
		fmt.Sprintf("cd %s && omp --resume %s", shellQuote("/work"), shellQuote("missing-id")),
		fmt.Sprintf("cd %s && omp --resume %s", shellQuote("/work"), shellQuote("foreign-scope-id")),
		"cd '/tmp' && omp --resume 'missing-id'; touch SHOULD_NOT_EXIST",
	}, "\n")
	if err := os.WriteFile(source, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}

	checkpoints, err := ImportLegacyRecovery(scope, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(checkpoints) != 1 || len(checkpoints[0].Legacy) != 3 || len(checkpoints[0].Warnings) != 1 {
		t.Fatalf("legacy import diagnostics are incomplete: %#v", checkpoints)
	}
	if !strings.Contains(checkpoints[0].Legacy[0].Unavailable, "More than one transcript") ||
		!strings.Contains(checkpoints[0].Legacy[1].Unavailable, "No transcript") ||
		!strings.Contains(checkpoints[0].Legacy[1].Unavailable, "working directory is unavailable") ||
		!strings.Contains(checkpoints[0].Legacy[2].Unavailable, "No transcript") {
		t.Fatalf("missing, ambiguous, or cross-scope IDs were not diagnosed: %#v", checkpoints[0].Legacy)
	}
	if strings.Contains(strings.Join(checkpoints[0].Warnings, "\n"), "SHOULD_NOT_EXIST") {
		t.Fatalf("unsupported executable input leaked into warnings: %#v", checkpoints[0].Warnings)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(source), "SHOULD_NOT_EXIST")); !os.IsNotExist(err) {
		t.Fatalf("legacy import executed unsupported shell text: %v", err)
	}
}

func TestImportLegacyRecoveryDefaultsToSnapshotsAndActiveHistory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	helper := filepath.Join(home, ".local", "state", "omp-session-resume-helper")
	snapshots := filepath.Join(helper, "snapshots")
	if err := os.MkdirAll(snapshots, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(helper, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(snapshots, 0o700); err != nil {
		t.Fatal(err)
	}
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	snapshotFile := filepath.Join(snapshots, "one.txt")
	activeFile := filepath.Join(helper, "active-sessions.txt")
	if err := os.WriteFile(snapshotFile, []byte("cd '/one' && omp --resume 'one'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(activeFile, []byte("cd '/two' && omp --resume 'two'\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	checkpoints, err := ImportLegacyRecovery(scope, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(checkpoints) != 2 {
		t.Fatalf("default legacy sources produced %d checkpoints, want snapshot plus active history", len(checkpoints))
	}
	paths := []string{checkpoints[0].SourcePath, checkpoints[1].SourcePath}
	if paths[0] != activeFile || paths[1] != snapshotFile {
		t.Fatalf("default legacy sources are not deterministic: %#v", paths)
	}
}

func TestImportLegacyRecoveryRejectsSymlinkSourceAndTranscript(t *testing.T) {
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	realSource := filepath.Join(t.TempDir(), "real.txt")
	if err := os.WriteFile(realSource, []byte("cd '/work' && omp --resume 'legacy'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkedSource := filepath.Join(filepath.Dir(realSource), "linked.txt")
	if err := os.Symlink(realSource, linkedSource); err != nil {
		t.Fatal(err)
	}
	if _, err := ImportLegacyRecovery(scope, linkedSource); err == nil {
		t.Fatal("symlink source was accepted")
	}

	transcriptLink := filepath.Join(scope.AgentDir, "sessions", "linked.jsonl")
	target := filepath.Join(t.TempDir(), "target.jsonl")
	if err := os.WriteFile(target, []byte("{\"type\":\"session\",\"id\":\"legacy\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, transcriptLink); err != nil {
		t.Fatal(err)
	}
	if _, err := ImportLegacyRecovery(scope, realSource); err == nil || strings.Contains(err.Error(), "No transcript") {
		t.Fatalf("unsafe transcript symlink was ignored instead of rejected: %v", err)
	}
}

func TestLegacyParserRequiresFullyQuotedExactFormat(t *testing.T) {
	cwd := "/work/a'b"
	sessionID := "id-with-'-quote"
	line := fmt.Sprintf("cd %s && omp --resume %s", shellQuote(cwd), shellQuote(sessionID))
	parsedCWD, parsedID, ok := parseLegacyRecoveryCommand(line)
	if !ok || parsedCWD != cwd || parsedID != sessionID {
		t.Fatalf("strict parser failed the old apostrophe escaping format: cwd=%q id=%q ok=%v", parsedCWD, parsedID, ok)
	}
	for _, unsupported := range []string{
		"cd /work && omp --resume 'id'",
		"cd '/work' && omp --resume id",
		"cd '/work' && omp --resume 'id' && touch file",
	} {
		if _, _, ok := parseLegacyRecoveryCommand(unsupported); ok {
			t.Fatalf("unsupported legacy command was accepted: %q", unsupported)
		}
	}
}

func writeLegacyTranscript(t *testing.T, scope protocol.Scope, relativePath, sessionID string) string {
	t.Helper()
	file := filepath.Join(scope.AgentDir, "sessions", relativePath)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	contents := fmt.Sprintf("{\"type\":\"session\",\"version\":1,\"id\":%q}\n", sessionID)
	if err := os.WriteFile(file, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestImportLegacyRecoveryUsesImportTimeAndPrunesToRetainedHistory(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(filepath.Dir(scope.AgentDir), "runtime"))
	currentBoot, err := readBootID()
	if err != nil {
		t.Fatal(err)
	}
	previousBoot := "00000000-0000-4000-8000-000000000000"
	if previousBoot == currentBoot {
		previousBoot = "11111111-1111-4111-8111-111111111111"
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	previous := protocol.RecoveryCheckpoint{
		Version: 1, CheckpointID: strings.Repeat("f", 32), Scope: scope, BootID: previousBoot,
		CreatedAt: time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339Nano),
		Reason:    "automatic", Entries: []protocol.RecoveryCheckpointEntry{},
	}
	if err := validateRecoveryCheckpoint(previous, scope, previous.CheckpointID); err != nil {
		t.Fatal(err)
	}
	if err := publishImmutableRecoveryCheckpoint(directories, previous); err != nil {
		t.Fatal(err)
	}
	transport, err := NewTransport(scope)
	if err != nil {
		t.Fatal(err)
	}
	record := testRecord(scope, strings.Repeat("1", 32))
	record.RestoreID = session.RestoreID
	record.SessionID = session.SessionID
	record.CWD = session.CWD
	record.SessionFile = stringPointer(session.SessionFile)
	if err := WritePrivateJSON(filepath.Join(transport.directory, record.InstanceID+".json"), record); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 10; index++ {
		if _, err := CaptureRecoveryCheckpoint(scope, "automatic", ""); err != nil {
			t.Fatal(err)
		}
	}

	oldSourceTime := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	home := t.TempDir()
	t.Setenv("HOME", home)
	helper := filepath.Join(home, ".local", "state", "omp-session-resume-helper")
	snapshotDirectory := filepath.Join(helper, "snapshots")
	if err := os.MkdirAll(snapshotDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{helper, snapshotDirectory} {
		if err := os.Chmod(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for index := 0; index < 12; index++ {
		source := filepath.Join(snapshotDirectory, fmt.Sprintf("snapshot-%02d.txt", index))
		if err := os.WriteFile(source, []byte("not a supported command\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(source, oldSourceTime, oldSourceTime); err != nil {
			t.Fatal(err)
		}
	}
	importStarted := time.Now().UTC()
	imported, err := ImportLegacyRecovery(scope, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(imported) != 10 {
		t.Fatalf("import returned %d checkpoints, want only 10 retained imports", len(imported))
	}
	history, err := ListRecoveryCheckpoints(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 11 {
		t.Fatalf("history retained %d checkpoints, want 10 newest plus protected prior boot", len(history))
	}
	retainedIDs := make(map[string]struct{}, len(history))
	protectedPreviousBoot := false
	for _, checkpoint := range history {
		retainedIDs[checkpoint.CheckpointID] = struct{}{}
		if checkpoint.CheckpointID == previous.CheckpointID && checkpoint.BootID == previousBoot {
			protectedPreviousBoot = true
		}
	}
	if !protectedPreviousBoot {
		t.Fatal("import pruning removed the protected previous-boot checkpoint")
	}
	for _, checkpoint := range imported {
		if _, retained := retainedIDs[checkpoint.CheckpointID]; !retained {
			t.Fatalf("import returned a checkpoint that pruning removed: %s", checkpoint.CheckpointID)
		}
		createdAt, err := time.Parse(time.RFC3339Nano, checkpoint.CreatedAt)
		if err != nil {
			t.Fatal(err)
		}
		if createdAt.Before(importStarted) || !createdAt.After(oldSourceTime) {
			t.Fatalf("import checkpoint used source age instead of import creation time: %s", checkpoint.CreatedAt)
		}
	}
}
