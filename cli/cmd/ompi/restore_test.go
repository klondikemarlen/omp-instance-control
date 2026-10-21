package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestParseRestoreSaveOptionsAfterName(t *testing.T) {
	instanceID := strings.Repeat("a", 32)
	options, err := parseRestoreOptions([]string{"save", "work", "--instance", instanceID, "--profile", "Work"})
	if err != nil {
		t.Fatal(err)
	}
	if err := validateRestoreOptions(options); err != nil {
		t.Fatal(err)
	}
	if options.positionals[0] != "save" || options.positionals[1] != "work" ||
		options.instance != instanceID || options.profile != "Work" {
		t.Fatalf("parsed restore options = %#v", options)
	}
}

func TestParseRestoreListJSONOptions(t *testing.T) {
	options, err := parseRestoreOptions([]string{"--list", "--json", "--profile", "Work"})
	if err != nil {
		t.Fatal(err)
	}
	if err := validateRestoreOptions(options); err != nil {
		t.Fatal(err)
	}
	if !options.list || !options.json || options.profile != "Work" {
		t.Fatalf("parsed restore options = %#v", options)
	}
}

func TestRestoreMenuCancellationDoesNotSelectSession(t *testing.T) {
	sessions := []protocol.RecoverySession{{
		RestoreID: strings.Repeat("a", 32),
		Name:      "project",
		Session:   &protocol.SavedSession{SessionID: "session-1", CWD: "/work/project"},
	}}
	var output bytes.Buffer
	selected, confirmed, err := chooseRecoverySession(strings.NewReader("q\n"), &output, sessions)
	if err != nil {
		t.Fatal(err)
	}
	if confirmed || selected.Name != "" {
		t.Fatalf("cancelled menu selected a restore: session=%#v confirmed=%v", selected, confirmed)
	}
}

func TestRestoreMenuRequiresConfirmationAndSanitizesDisplayText(t *testing.T) {
	session := protocol.RecoverySession{
		RestoreID: strings.Repeat("a", 32),
		Name:      "project",
		Session:   &protocol.SavedSession{SessionID: "session-1\x1b[31m", CWD: "/work/project\x1b[2J"},
	}
	var output bytes.Buffer
	selected, confirmed, err := chooseRecoverySession(strings.NewReader("1\nn\n"), &output, []protocol.RecoverySession{session})
	if err != nil {
		t.Fatal(err)
	}
	if confirmed || selected.Name != "project" {
		t.Fatalf("declined confirmation result = session %#v, confirmed %v", selected, confirmed)
	}
	if strings.Contains(output.String(), "\x1b") || !strings.Contains(output.String(), `\u001b`) {
		t.Fatalf("restore menu emitted unsanitized terminal text: %q", output.String())
	}
}

func TestRestoreConfirmationAcceptsOnlyExplicitYes(t *testing.T) {
	session := protocol.NamedSession{Name: "project", Session: protocol.SavedSession{SessionID: "session-1", CWD: "/work"}}
	confirmed, err := confirmNamedRestore(strings.NewReader("yes\n"), &bytes.Buffer{}, session)
	if err != nil {
		t.Fatal(err)
	}
	if !confirmed {
		t.Fatal("explicit yes did not confirm restore")
	}
}

func TestRestoreMenuDoesNotConfirmUnavailableSnapshot(t *testing.T) {
	session := protocol.RecoverySession{
		RestoreID:   strings.Repeat("a", 32),
		Name:        "project",
		Unavailable: "Current wrapper slot has no persisted restore snapshot.",
	}
	var output bytes.Buffer
	selected, confirmed, err := chooseRecoverySession(strings.NewReader("1\ny\n"), &output, []protocol.RecoverySession{session})
	if err == nil {
		t.Fatal("unavailable session was not refused")
	}
	if confirmed || selected.RestoreID != "" {
		t.Fatalf("unavailable menu selected a runnable slot: %#v, confirmed %v", selected, confirmed)
	}
}
