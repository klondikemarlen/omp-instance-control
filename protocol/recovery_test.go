package protocol

import (
	"encoding/json"
	"testing"
)

func TestRecoveryCheckpointAndSessionUseSharedWireNames(t *testing.T) {
	checkpoint := RecoveryCheckpoint{
		Version: 1, CheckpointID: "0123456789abcdef0123456789abcdef",
		Scope:  Scope{ID: "0123456789abcdef", ConfigRoot: "/config", Profile: "default", AgentDir: "/agent"},
		BootID: "00000000-0000-4000-8000-000000000000", CreatedAt: "2026-10-21T00:00:00Z",
		Reason: "manual", Entries: []RecoveryCheckpointEntry{{
			RestoreID: "11111111111111111111111111111111", SessionID: "session-1", CWD: "/work",
		}},
	}
	encoded, err := json.Marshal(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	entries, ok := decoded["entries"].([]any)
	if !ok || len(entries) != 1 {
		t.Fatalf("checkpoint entries = %#v", decoded["entries"])
	}
	entry := entries[0].(map[string]any)
	if entry["restoreId"] != "11111111111111111111111111111111" || entry["sessionId"] != "session-1" || entry["cwd"] != "/work" {
		t.Fatalf("checkpoint entry wire fields = %#v", entry)
	}
	if decoded["checkpointId"] != checkpoint.CheckpointID || decoded["bootId"] != checkpoint.BootID || decoded["createdAt"] != checkpoint.CreatedAt {
		t.Fatalf("checkpoint wire fields = %#v", decoded)
	}
	if _, exists := decoded["legacy"]; exists {
		t.Fatalf("empty legacy entries were not omitted: %#v", decoded)
	}

	legacy := RecoveryLegacyEntry{CWD: "/work", SessionID: "legacy-session", SessionFile: "/agent/sessions/session.jsonl"}
	legacySession, err := json.Marshal(RecoverySession{Legacy: &legacy})
	if err != nil {
		t.Fatal(err)
	}
	var legacyDecoded map[string]any
	if err := json.Unmarshal(legacySession, &legacyDecoded); err != nil {
		t.Fatal(err)
	}
	if len(legacyDecoded) != 1 || legacyDecoded["legacy"].(map[string]any)["sessionFile"] != legacy.SessionFile {
		t.Fatalf("legacy session wire fields = %#v", legacyDecoded)
	}
}
