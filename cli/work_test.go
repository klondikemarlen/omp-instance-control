package cli

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestResolveWorkSessionUsesCurrentSavedConversation(t *testing.T) {
	claim := sampleWorkClaim()
	row := workProbe(strings.Repeat("a", 32), claim)
	row.Record.SessionID = "previous-session"
	row.Record.SessionFile = nil
	row.Record.CWD = "/not-current"

	got, err := ResolveWorkSession([]Row{row}, "aaaa")
	if err != nil || got != row.Data {
		t.Fatalf("ResolveWorkSession = %#v, %v; want current live status", got, err)
	}
}

func TestResolveWorkSessionRejectsAmbiguityIncludingStaleRegistrations(t *testing.T) {
	claim := sampleWorkClaim()
	live := workProbe(strings.Repeat("a", 32), claim)
	stale := workProbe("aaaa"+strings.Repeat("b", 28), claim)
	stale.Status = "unreachable"
	stale.Data = nil

	if got, err := ResolveWorkSession([]Row{live, stale}, "aaaa"); got != nil || err == nil || !strings.Contains(err.Error(), "multiple registrations") {
		t.Fatalf("ResolveWorkSession = %#v, %v; want ambiguous selection", got, err)
	}
	if got, err := ResolveWorkSession([]Row{live, stale}, "aaaaa"); got != live.Data || err != nil {
		t.Fatalf("ResolveWorkSession = %#v, %v; want the longer prefix to resolve one launch", got, err)
	}
}

func TestResolveWorkSessionRequiresAVerifiedRunningSavedSession(t *testing.T) {
	for _, test := range []struct {
		name     string
		prefix   string
		mutate   func(*Row)
		wantText string
	}{
		{
			name:     "empty prefix",
			wantText: "invalid work instance ID",
		},
		{
			name:     "uppercase prefix",
			prefix:   "AA",
			wantText: "invalid work instance ID",
		},
		{
			name:     "no matching record",
			prefix:   "b",
			wantText: "no matching work instance",
		},
		{
			name:     "unreachable",
			prefix:   "a",
			mutate:   func(row *Row) { row.Status = "unreachable" },
			wantText: "unreachable",
		},
		{
			name:     "failed probe",
			prefix:   "a",
			mutate:   func(row *Row) { row.Status = "unknown" },
			wantText: "could not verify",
		},
		{
			name:     "wrong live launch",
			prefix:   "a",
			mutate:   func(row *Row) { row.Data.InstanceID = strings.Repeat("b", 32) },
			wantText: "could not verify",
		},
		{
			name:     "wrong live scope",
			prefix:   "a",
			mutate:   func(row *Row) { row.Data.Scope = "other" },
			wantText: "could not verify",
		},
		{
			name:     "empty live session ID",
			prefix:   "a",
			mutate:   func(row *Row) { row.Data.SessionID = "" },
			wantText: "no verified saved conversation",
		},
		{
			name:     "unsaved live session",
			prefix:   "a",
			mutate:   func(row *Row) { row.Data.SessionFile = nil },
			wantText: "no verified saved conversation",
		},
		{
			name:   "relative session file",
			prefix: "a",
			mutate: func(row *Row) {
				file := "relative.jsonl"
				row.Data.SessionFile = &file
			},
			wantText: "no verified saved conversation",
		},
		{
			name:     "restarting live session",
			prefix:   "a",
			mutate:   func(row *Row) { row.Data.State = "restart-requested" },
			wantText: "not running normally",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			claim := sampleWorkClaim()
			row := workProbe(strings.Repeat("a", 32), claim)
			if test.mutate != nil {
				test.mutate(&row)
			}
			got, err := ResolveWorkSession([]Row{row}, test.prefix)
			if got != nil || err == nil || !strings.Contains(err.Error(), test.wantText) {
				t.Errorf("ResolveWorkSession = %#v, %v; want error containing %q", got, err, test.wantText)
			}
		})
	}
}

func TestWorkDirectoryRoutesSameWorktreeClaimsAndTracksRelaunch(t *testing.T) {
	first := sampleWorkClaim()
	second := first
	second.SessionID = "session-second"
	second.SessionFile = "/agent/sessions/second.jsonl"
	second.URL = "https://github.com/owner/repo/pull/5"
	second.UpdatedAt = "2026-11-19T12:00:00.000000001Z"
	now := time.Date(2026, 11, 20, 12, 0, 0, 1, time.UTC)
	oldID := strings.Repeat("a", 32)
	newID := strings.Repeat("b", 32)
	secondID := strings.Repeat("c", 32)

	old := workProbe(oldID, first)
	old.Status = "unreachable"
	old.Data = nil
	relaunched := workProbe(newID, first)
	relaunched.Record.SessionFile = nil
	otherTask := workProbe(secondID, second)
	rows := WorkDirectory([]protocol.WorkClaim{second, first}, []Row{otherTask, old, relaunched}, "", now)
	if len(rows) != 2 || rows[0].WorkClaim != first || rows[1].WorkClaim != second {
		t.Fatalf("directory must preserve both claims in deterministic order: %#v", rows)
	}
	assertWorkOwner(t, rows[0], "online", false, false, newID)
	assertWorkOwner(t, rows[1], "online", false, false, secondID)

	matches := WorkDirectory([]protocol.WorkClaim{second, first}, []Row{otherTask, old, relaunched}, second.URL, now.Add(time.Nanosecond))
	if len(matches) != 1 || matches[0].WorkClaim != second {
		t.Fatalf("lookup must match only its URL: %#v", matches)
	}
	assertWorkOwner(t, matches[0], "online", true, false, secondID)
}

func TestWorkDirectoryKeepsAllConflicts(t *testing.T) {
	first := sampleWorkClaim()
	second := first
	second.SessionFile = "/agent/sessions/different-file-with-same-id.jsonl"
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	firstID := strings.Repeat("a", 32)
	anotherID := strings.Repeat("b", 32)
	firstLaunch := workProbe(firstID, first)
	secondLaunch := workProbe(anotherID, first)

	matches := WorkDirectory([]protocol.WorkClaim{second, first}, []Row{secondLaunch, firstLaunch}, first.URL, now)
	if len(matches) != 2 || matches[0].WorkClaim != first || matches[1].WorkClaim != second {
		t.Fatalf("lookup must keep both owners and distinguish identical IDs at different files: %#v", matches)
	}
	assertWorkOwner(t, matches[0], "ambiguous", false, true, firstID, anotherID)
	assertWorkOwner(t, matches[1], "offline", false, true)

	singleClaim := WorkDirectory([]protocol.WorkClaim{first}, []Row{secondLaunch, firstLaunch}, "", now)
	assertWorkOwner(t, singleClaim[0], "ambiguous", false, true, firstID, anotherID)
}

func TestWorkDirectoryDistinguishesUnverifiableFromOffline(t *testing.T) {
	claim := sampleWorkClaim()
	claim.UpdatedAt = "2026-11-18T12:00:00Z"
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	id := strings.Repeat("a", 32)
	otherScope := claim
	otherScope.Scope = "other-scope"
	otherScopeProbe := workProbe(strings.Repeat("b", 32), otherScope)
	differentConversation := claim
	differentConversation.SessionID = "different-session-id"
	otherConversationProbe := workProbe(strings.Repeat("c", 32), differentConversation)
	otherConversationProbe.Status = "failed"
	otherConversationProbe.Data = nil
	unreachable := workProbe(id, claim)
	unreachable.Status = "unreachable"
	unreachable.Data = nil
	offline := WorkDirectory([]protocol.WorkClaim{claim}, []Row{otherScopeProbe, otherConversationProbe, unreachable}, claim.URL, now)
	assertWorkOwner(t, offline[0], "offline", true, false)

	unresolved := workProbe(id, claim)
	unresolved.Status = "unknown"
	unresolved.Data = nil
	unavailable := WorkDirectory([]protocol.WorkClaim{claim}, []Row{otherScopeProbe, unresolved}, claim.URL, now)
	assertWorkOwner(t, unavailable[0], "unavailable", true, false)

	unresolved.Record.SessionFile = nil
	candidate := workProbe(strings.Repeat("d", 32), claim)
	withUnresolvedCandidate := WorkDirectory([]protocol.WorkClaim{claim}, []Row{candidate, unresolved}, claim.URL, now)
	assertWorkOwner(t, withUnresolvedCandidate[0], "unavailable", true, false, candidate.Data.InstanceID)

	candidate.Data.State = "restart-requested"
	restarting := WorkDirectory([]protocol.WorkClaim{claim}, []Row{candidate}, claim.URL, now)
	assertWorkOwner(t, restarting[0], "unavailable", true, false, candidate.Data.InstanceID)

	candidate.Data.State = "running"
	candidate.Data.SessionFile = nil
	unsaved := WorkDirectory([]protocol.WorkClaim{claim}, []Row{candidate}, claim.URL, now)
	assertWorkOwner(t, unsaved[0], "offline", true, false)

	encoded, err := json.Marshal(offline[0])
	if err != nil || !strings.Contains(string(encoded), `"instanceIds":[]`) {
		t.Fatalf("offline JSON should expose an empty ID array: %s (%v)", encoded, err)
	}
}

func sampleWorkClaim() protocol.WorkClaim {
	return protocol.WorkClaim{
		Version:     protocol.WorkClaimVersion,
		Scope:       "aaaaaaaaaaaaaaaa",
		SessionID:   "saved-session",
		SessionFile: "/agent/sessions/claimed.jsonl",
		CWD:         "/worktree",
		URL:         "https://github.com/owner/repo/issues/93",
		Summary:     "Track ownership",
		UpdatedAt:   "2026-11-20T12:00:00Z",
	}
}

func workProbe(instanceID string, claim protocol.WorkClaim) Row {
	return Row{
		Record: &protocol.Record{
			Version:     protocol.Version,
			InstanceID:  instanceID,
			Scope:       claim.Scope,
			CWD:         claim.CWD,
			SessionID:   claim.SessionID,
			SessionFile: &claim.SessionFile,
			State:       "running",
		},
		Status: "online",
		Data: &protocol.Data{
			Version:     protocol.Version,
			InstanceID:  instanceID,
			Scope:       claim.Scope,
			CWD:         claim.CWD,
			SessionID:   claim.SessionID,
			SessionFile: &claim.SessionFile,
			State:       "running",
		},
	}
}

func assertWorkOwner(t *testing.T, row WorkRow, availability string, stale, conflict bool, instanceIDs ...string) {
	t.Helper()
	if row.Availability != availability || row.Stale != stale || row.Conflict != conflict || row.InstanceIDs == nil || !slices.Equal(row.InstanceIDs, instanceIDs) {
		t.Fatalf("owner = %s, stale=%v, conflict=%v, ids=%#v; want %s, stale=%v, conflict=%v, ids=%#v", row.Availability, row.Stale, row.Conflict, row.InstanceIDs, availability, stale, conflict, instanceIDs)
	}
}
