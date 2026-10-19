package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateRestoreNameEnforcesImmutableNameSyntax(t *testing.T) {
	valid := []string{"A", "0", "project-1", "project.name", strings.Repeat("x", 64)}
	for _, name := range valid {
		if err := ValidateRestoreName(name); err != nil {
			t.Errorf("ValidateRestoreName(%q) returned %v", name, err)
		}
	}

	invalid := []string{"", "save", "../project", " project", "project/other", strings.Repeat("x", 65), "é"}
	for _, name := range invalid {
		if err := ValidateRestoreName(name); err == nil {
			t.Errorf("ValidateRestoreName(%q) unexpectedly succeeded", name)
		}
	}
}

func TestSavedSessionAndNamedSessionUseWireFieldNames(t *testing.T) {
	session := SavedSession{
		Version: 1, RestoreID: strings.Repeat("a", 32),
		Scope:       Scope{ID: "0123456789abcdef", ConfigRoot: "/home/user/.omp", Profile: "default", AgentDir: "/home/user/.omp/agent"},
		SessionFile: "/home/user/.omp/agent/sessions/session.jsonl", SessionID: "session-1",
		CWD: "/work/project", ResumeArgs: []string{"--model=small"},
		Owner:      RestoreOwner{BootID: "00000000-0000-4000-8000-000000000000", PID: 41, StartTime: "123"},
		AgentOwner: RestoreOwner{BootID: "00000000-0000-4000-8000-000000000000", PID: 42, StartTime: "456"},
		UpdatedAt:  "2026-10-19T12:00:00Z",
	}
	encoded, err := json.Marshal(NamedSession{Name: "project", Session: session})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["name"] != "project" {
		t.Fatalf("named session name field = %#v", decoded["name"])
	}
	encodedSession, ok := decoded["session"].(map[string]any)
	if !ok {
		t.Fatalf("named session payload = %#v", decoded["session"])
	}
	for _, field := range []string{"restoreId", "scope", "sessionFile", "sessionId", "cwd", "resumeArgs", "owner", "agentOwner", "updatedAt"} {
		if _, exists := encodedSession[field]; !exists {
			t.Errorf("saved session JSON omitted %q: %s", field, encoded)
		}
	}
	for _, ownerField := range []string{"owner", "agentOwner"} {
		encodedOwner, ok := encodedSession[ownerField].(map[string]any)
		if !ok {
			t.Fatalf("saved %s payload = %#v", ownerField, encodedSession[ownerField])
		}
		for _, field := range []string{"bootId", "pid", "startTime"} {
			if _, exists := encodedOwner[field]; !exists {
				t.Errorf("restore %s JSON omitted %q: %s", ownerField, field, encoded)
			}
		}
	}
}

func TestUnavailableNamedSessionOmitsZeroSnapshot(t *testing.T) {
	reason := "Current wrapper slot has no persisted restore snapshot."
	encoded, err := json.Marshal(NamedSession{Name: "alpha", Unavailable: reason})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["name"] != "alpha" || decoded["unavailable"] != reason {
		t.Fatalf("unavailable named session JSON = %#v", decoded)
	}
	if _, exists := decoded["session"]; exists {
		t.Fatalf("unavailable named session serialized empty session metadata: %s", encoded)
	}
}
