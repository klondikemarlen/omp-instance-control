package linux

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestRetainedLegacyCheckpointReadsTitlePrefixedTranscript(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	contents := legacyTitlePreamble() + `{"type":"session","version":3,"id":"title-session"}` + "\n"
	transcript := writeRetainedLegacyTranscript(t, scope, contents)
	checkpoint := seedRetainedLegacyCheckpoint(t, scope, protocol.RecoveryLegacyEntry{
		CWD:         session.CWD,
		SessionID:   "title-session",
		SessionFile: transcript,
	})

	sessions, err := ListRecoverySessions(scope, checkpoint.CheckpointID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].Legacy == nil || sessions[0].Legacy.SessionFile != transcript || sessions[0].Legacy.Unavailable != "" {
		t.Fatalf("retained title-prefixed transcript is not available for review: %#v", sessions)
	}
}

func TestLegacyTranscriptHeaderRequiresABoundedRecognizedPreamble(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		contents string
		valid    bool
	}{
		{"session header only", "{\"type\":\"session\",\"id\":\"expected\"}\n", true},
		{"title then session header", legacyTitlePreamble() + "{\"type\":\"session\",\"id\":\"expected\"}\n", true},
		{"unknown preamble", "{\"type\":\"message\"}\n{\"type\":\"session\",\"id\":\"expected\"}\n", false},
		{"short title slot", "{\"type\":\"title\",\"v\":1}\n{\"type\":\"session\",\"id\":\"expected\"}\n", false},
		{"unsupported title version", strings.Replace(legacyTitlePreamble(), "\"v\":1", "\"v\":2", 1) + "{\"type\":\"session\",\"id\":\"expected\"}\n", false},
		{"oversized prefix", legacyTitlePreamble() + "{\"type\":\"session\",\"id\":\"expected\",\"padding\":\"" + strings.Repeat("x", maxLegacySessionHeaderBytes-256) + "\"}\n", false},
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

func legacyTitlePreamble() string {
	title := `{"type":"title","v":1,"title":"Example"}`
	return title + strings.Repeat(" ", 255-len(title)) + "\n"
}
