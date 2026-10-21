package linux

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestLegacyRecoveryReimportsTitlePrefixedTranscriptAfterOldMissingResult(t *testing.T) {
	scope, _ := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	cwd := filepath.Join(filepath.Dir(scope.AgentDir), "title-project")
	if err := os.Mkdir(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	transcript := writeLegacyTranscript(t, scope, "title.jsonl", "title-session")
	contents := "{\"type\":\"title\",\"v\":1,\"title\":\"Example\"}\n{\"type\":\"session\",\"version\":3,\"id\":\"title-session\"}\n"
	if err := os.WriteFile(transcript, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "snapshot.txt")
	commands := []byte(fmt.Sprintf("cd %s && omp --resume 'title-session'\n", shellQuote(cwd)))
	if err := os.WriteFile(source, commands, 0o600); err != nil {
		t.Fatal(err)
	}
	oldIdentity := sha256.New()
	_, _ = oldIdentity.Write([]byte(source))
	_, _ = oldIdentity.Write([]byte{0})
	_, _ = oldIdentity.Write(commands)
	oldID := hex.EncodeToString(oldIdentity.Sum(nil)[:16])
	contentHash := sha256.Sum256(commands)
	oldCheckpoint := protocol.RecoveryCheckpoint{
		Version: 1, CheckpointID: oldID, Scope: scope, BootID: "legacy",
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Reason: "legacy",
		Entries: []protocol.RecoveryCheckpointEntry{},
		Legacy: []protocol.RecoveryLegacyEntry{{
			CWD: cwd, SessionID: "title-session",
			Unavailable: "No transcript with this session ID exists in the selected OMP scope.",
		}},
		SourcePath: source, SourceSha256: hex.EncodeToString(contentHash[:]),
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	if err := publishImmutableRecoveryCheckpoint(directories, oldCheckpoint); err != nil {
		t.Fatal(err)
	}

	imported, err := ImportLegacyRecovery(scope, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(imported) != 1 || len(imported[0].Legacy) != 1 {
		t.Fatalf("expected one imported session: %#v", imported)
	}
	entry := imported[0].Legacy[0]
	if entry.SessionFile != transcript || entry.Unavailable != "" {
		t.Fatalf("reimport retained a false missing-transcript result: %#v", entry)
	}
}

func TestLegacyTranscriptHeaderRequiresABoundedRecognizedPreamble(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		contents string
		valid    bool
	}{
		{"session header only", "{\"type\":\"session\",\"id\":\"expected\"}\n", true},
		{"title then session header", "{\"type\":\"title\",\"v\":1}\n{\"type\":\"session\",\"id\":\"expected\"}\n", true},
		{"unknown preamble", "{\"type\":\"message\"}\n{\"type\":\"session\",\"id\":\"expected\"}\n", false},
		{"unsupported title version", "{\"type\":\"title\",\"v\":2}\n{\"type\":\"session\",\"id\":\"expected\"}\n", false},
		{"oversized prefix", "{\"type\":\"title\",\"v\":1,\"title\":\"" + strings.Repeat("x", maxLegacySessionHeaderBytes-64) + "\"}\n{\"type\":\"session\",\"id\":\"expected\"}\n", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "session.jsonl")
			if err := os.WriteFile(file, []byte(scenario.contents), 0o600); err != nil {
				t.Fatal(err)
			}

			id, valid, err := readLegacySessionID(file)
			if err != nil {
				t.Fatal(err)
			}
			if valid != scenario.valid || (valid && id != "expected") {
				t.Fatalf("session header result: id=%q valid=%v, want valid=%v", id, valid, scenario.valid)
			}
		})
	}
}
