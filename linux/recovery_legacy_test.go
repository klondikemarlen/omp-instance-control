package linux

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestRetainedLegacyCheckpointAppearsInHistoryWithoutManagedEntries(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	checkpoint := seedRetainedLegacyCheckpoint(t, scope, protocol.RecoveryLegacyEntry{
		CWD:         session.CWD,
		SessionID:   "unavailable-session",
		Unavailable: "No transcript with this session ID exists in the selected OMP scope.",
	})

	history, err := ListRecoveryCheckpoints(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].CheckpointID != checkpoint.CheckpointID || history[0].Reason != "legacy" || len(history[0].Entries) != 0 {
		t.Fatalf("history did not retain the unowned legacy checkpoint: %#v", history)
	}
	if len(history[0].Warnings) != 1 || history[0].Warnings[0] != "line 2: unsupported legacy command format" {
		t.Fatalf("history did not preserve the safe legacy warning: %#v", history[0].Warnings)
	}
}

func TestRetainedLegacyCheckpointListAllowsExplicitButNotDefaultSelection(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	transcript := writeRetainedLegacyTranscript(t, scope, `{"type":"session","id":"legacy-session"}`+"\n")
	checkpoint := seedRetainedLegacyCheckpoint(t, scope, protocol.RecoveryLegacyEntry{
		CWD:         session.CWD,
		SessionID:   "legacy-session",
		SessionFile: transcript,
	})

	selected, err := ListRecoverySessions(scope, checkpoint.CheckpointID)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 1 || selected[0].Legacy == nil || selected[0].RestoreID != "" || selected[0].Session != nil {
		t.Fatalf("explicit legacy selection must not invent a managed slot: %#v", selected)
	}
	defaultCandidates, err := ListRecoverySessions(scope, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range defaultCandidates {
		if candidate.Legacy != nil {
			t.Fatalf("default recovery unexpectedly selected an unowned legacy entry: %#v", candidate)
		}
	}
}

func TestRetainedLegacyCheckpointExportsSafelyQuotedManualCommand(t *testing.T) {
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	home := filepath.Dir(scope.ConfigRoot)
	t.Setenv("HOME", home)
	cwd := filepath.Join(filepath.Dir(scope.AgentDir), "project's work")
	if err := os.Mkdir(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	transcript := writeRetainedLegacyTranscript(t, scope, `{"type":"session","id":"legacy-session"}`+"\n")
	checkpoint := seedRetainedLegacyCheckpoint(t, scope, protocol.RecoveryLegacyEntry{
		CWD:         cwd,
		SessionID:   "legacy-session",
		SessionFile: transcript,
	})
	sessions, err := ListRecoverySessions(scope, checkpoint.CheckpointID)
	if err != nil {
		t.Fatal(err)
	}

	exported, err := ExportRecoveryCommands(scope, sessions)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(exported, "unowned; review before running") ||
		!strings.Contains(exported, `/project'\''s work' && env `) ||
		!strings.Contains(exported, "HOME='"+home+"' PI_CONFIG_DIR='config' OMP_PROFILE='default'") ||
		!strings.Contains(exported, ` ompi -r '`+filepath.Dir(transcript)+`/legacy'\''s session.jsonl'`) {
		t.Fatalf("legacy export was not a quoted manual resume command: %s", exported)
	}
}

func TestRetainedLegacyCheckpointDoesNotExportWhenTranscriptDisappears(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	transcript := writeRetainedLegacyTranscript(t, scope, `{"type":"session","id":"legacy-session"}`+"\n")
	checkpoint := seedRetainedLegacyCheckpoint(t, scope, protocol.RecoveryLegacyEntry{
		CWD:         session.CWD,
		SessionID:   "legacy-session",
		SessionFile: transcript,
	})
	if err := os.Remove(transcript); err != nil {
		t.Fatal(err)
	}
	sessions, err := ListRecoverySessions(scope, checkpoint.CheckpointID)
	if err != nil {
		t.Fatal(err)
	}

	exported, err := ExportRecoveryCommands(scope, sessions)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(exported, "no command was generated") || strings.Contains(exported, "ompi -r") {
		t.Fatalf("legacy export did not downgrade the missing transcript: %s", exported)
	}
}

func TestRetainedLegacyCheckpointRejectsUnsafeOrMismatchedTranscripts(t *testing.T) {
	for _, scenario := range []string{"symlink", "other scope", "mismatched header"} {
		t.Run(scenario, func(t *testing.T) {
			scope, session := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
			transcript := writeRetainedLegacyTranscript(t, scope, `{"type":"session","id":"different-session"}`+"\n")
			var expectedError string
			switch scenario {
			case "symlink":
				link := filepath.Join(filepath.Dir(transcript), "symlink.jsonl")
				if err := os.Symlink(transcript, link); err != nil {
					t.Fatal(err)
				}
				transcript = link
				expectedError = "legacy session file is unsafe"
			case "other scope":
				other, _ := newRestoreFixture(t, strings.Repeat("b", 32), stoppedRestoreOwner())
				transcript = writeRetainedLegacyTranscript(t, other, `{"type":"session","id":"legacy-session"}`+"\n")
				expectedError = "outside the selected OMP scope"
			case "mismatched header":
				expectedError = "no longer matches its imported session ID"
			}
			checkpoint := seedRetainedLegacyCheckpoint(t, scope, protocol.RecoveryLegacyEntry{
				CWD:         session.CWD,
				SessionID:   "legacy-session",
				SessionFile: transcript,
			})

			if _, err := ListRecoverySessions(scope, checkpoint.CheckpointID); err == nil || !strings.Contains(err.Error(), expectedError) {
				t.Fatalf("retained checkpoint did not reject %s: %v", scenario, err)
			}
		})
	}
}

func seedRetainedLegacyCheckpoint(t *testing.T, scope protocol.Scope, entry protocol.RecoveryLegacyEntry) protocol.RecoveryCheckpoint {
	t.Helper()
	checkpoint := protocol.RecoveryCheckpoint{
		Version:      1,
		CheckpointID: strings.Repeat("e", 32),
		Scope:        scope,
		BootID:       "legacy",
		CreatedAt:    "2025-01-01T00:00:00Z",
		Reason:       "legacy",
		Entries:      []protocol.RecoveryCheckpointEntry{},
		Legacy:       []protocol.RecoveryLegacyEntry{entry},
		SourcePath:   filepath.Join(filepath.Dir(scope.AgentDir), "old snapshot.txt"),
		SourceSha256: strings.Repeat("0", 64),
		Warnings:     []string{"line 2: unsupported legacy command format"},
	}
	directory := filepath.Join(scope.AgentDir, "instance-control", "restore", "checkpoints")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, checkpoint.CheckpointID+".json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return checkpoint
}

func writeRetainedLegacyTranscript(t *testing.T, scope protocol.Scope, contents string) string {
	t.Helper()
	file := filepath.Join(scope.AgentDir, "sessions", "nested", "legacy's session.jsonl")
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}
