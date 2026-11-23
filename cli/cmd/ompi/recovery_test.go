package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestRecoveryOptionsRejectConflictingWordsBeforeSideEffects(t *testing.T) {
	for _, args := range [][]string{
		{"checkpoint", "history"},
		{"slot", strings.Repeat("a", 32), "list"},
		{"checkpoint", "--json"},
		{"history", "--from", strings.Repeat("a", 32)},
		{"slot", strings.Repeat("a", 32), "--from", strings.Repeat("b", 32)},
		{"work", "export"},
		{"save", "work", "--instance", strings.Repeat("a", 32), "checkpoint"},
		{"export", "--json"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			options, err := parseRestoreOptions(args)
			if err == nil {
				err = validateRestoreOptions(options)
			}
			if err == nil {
				t.Fatalf("conflicting recovery actions were accepted: %#v", options)
			}
		})
	}
}

func TestObsoleteOperationFlagsAreRejected(t *testing.T) {
	for _, args := range [][]string{
		{"--list"}, {"--history"}, {"--checkpoint"}, {"--slot", strings.Repeat("a", 32)},
		{"--export"}, {"--import-legacy"}, {"--from", strings.Repeat("a", 32)},
	} {
		if _, err := parseRestoreOptions(args); err == nil {
			t.Fatalf("obsolete flag was accepted: %v", args)
		}
	}
}

func TestRecoveryIdentifiersCannotSelectPathsOrEmptyValues(t *testing.T) {
	for _, args := range [][]string{
		{"slot", ""}, {"slot", "../../other-session"}, {"from", "checkpoint.json"},
		{"list", "--from="}, {"export", "--from", ""},
	} {
		options, err := parseRestoreOptions(args)
		if err == nil {
			err = validateRestoreOptions(options)
		}
		if err == nil {
			t.Fatalf("unsafe recovery selector was accepted: %#v", options)
		}
	}
}

func TestCheckpointListPreservesExplicitSelectionAndScope(t *testing.T) {
	checkpointID := strings.Repeat("c", 32)
	options, err := parseRestoreOptions([]string{"list", "--json", "--from", checkpointID, "--profile", "work"})
	if err != nil {
		t.Fatal(err)
	}
	if err := validateRestoreOptions(options); err != nil {
		t.Fatal(err)
	}
	if !options.list || !options.json || options.from != checkpointID || options.profile != "work" {
		t.Fatalf("checkpoint selection was lost: %#v", options)
	}
}

func TestRetiredImportCommandDoesNotDispatch(t *testing.T) {
	scope := setUsageEnvironment(t, "1")
	source := filepath.Join(t.TempDir(), "recovery snapshot.txt")
	original := []byte("cd '/project' && omp --resume 'original'\n")
	if err := os.WriteFile(source, original, 0o600); err != nil {
		t.Fatal(err)
	}

	for _, args := range [][]string{
		{"import-legacy"},
		{"import-legacy", source, "--profile=work"},
	} {
		_, err := runRestore(args)
		if err == nil || !strings.Contains(err.Error(), "restore import-legacy has been removed") {
			t.Fatalf("retired import was not rejected: %v", err)
		}
	}
	contents, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(contents, original) {
		t.Fatalf("retired import modified the original helper file: %q %v", contents, err)
	}
	assertNoUsageDirectory(t, scope)
}

func TestExplicitRestoreNameStillAcceptsImportLegacy(t *testing.T) {
	options, err := parseRestoreOptions([]string{"name", "import-legacy"})
	if err != nil {
		t.Fatal(err)
	}
	if !options.name || options.namedTarget != "import-legacy" {
		t.Fatalf("explicit saved name changed meaning: %#v", options)
	}
}

func TestAutomaticRecoveryDoesNotRequireASavedName(t *testing.T) {
	slot := protocol.RecoverySession{
		RestoreID: strings.Repeat("d", 32),
		Session: &protocol.SavedSession{
			SessionID: "current-conversation",
			CWD:       "/work/ticket-worktree",
		},
	}
	selected, confirmed, err := chooseRecoverySession(strings.NewReader("1\ny\n"), &bytes.Buffer{}, []protocol.RecoverySession{slot})
	if err != nil {
		t.Fatal(err)
	}
	if !confirmed || selected.RestoreID != slot.RestoreID || selected.Name != "" {
		t.Fatalf("unnamed session was not selected explicitly: %#v, confirmed=%v", selected, confirmed)
	}
}

func TestLegacyRecoveryWithoutManagedOwnershipCannotBeConfirmed(t *testing.T) {
	session := protocol.RecoverySession{
		Legacy: &protocol.RecoveryLegacyEntry{
			SessionID:   "historical-session",
			CWD:         "/work/project",
			SessionFile: "/private/session.jsonl",
		},
	}
	selected, confirmed, err := chooseRecoverySession(strings.NewReader("1\ny\n"), &bytes.Buffer{}, []protocol.RecoverySession{session})
	if err == nil || confirmed || selected.RestoreID != "" {
		t.Fatalf("unowned legacy entry became a managed launch: %#v, confirmed=%v, error=%v", selected, confirmed, err)
	}
}

func TestLegacyRecoveryListShowsManualSessionWithoutInventingASlot(t *testing.T) {
	session := protocol.RecoverySession{
		Legacy: &protocol.RecoveryLegacyEntry{
			SessionID:   "historical-session",
			CWD:         "/work/project",
			SessionFile: "/private/session.jsonl",
		},
	}
	var output bytes.Buffer

	printRecoverySession(&output, 0, session)

	if !strings.Contains(output.String(), "historical-session /work/project") ||
		!strings.Contains(output.String(), "review/export only") ||
		strings.Contains(output.String(), "no managed session snapshot") {
		t.Fatalf("legacy recovery was not presented as manual data: %q", output.String())
	}
}
