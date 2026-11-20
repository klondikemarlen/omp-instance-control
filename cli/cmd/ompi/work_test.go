package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/klondikemarlen/omp-instance-control/cli"
	"github.com/klondikemarlen/omp-instance-control/linux"
	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const (
	workCommandURL = "https://github.com/org/repo/pull/93"
	workCommandID  = "abcdef00000000000000000000000000"
	workSessionID  = "session-1"
)

func TestWorkSetOutputsLiveConversationInExplicitProfile(t *testing.T) {
	scope := isolatedWorkScope(t, "work")
	file := filepath.Join(scope.AgentDir, "sessions", "live.jsonl")
	registerWorkStatus(t, scope, workCommandID, workSessionID, file)

	var output bytes.Buffer
	code, err := runWork(&output, []string{
		"set", "--profile", "work", "--json", "--branch", "issue-93/ownership",
		"abcdef", "https://github.com/Org/Repo/pull/93", "--profile work; literal $text",
	})

	if err != nil || code != 0 {
		t.Fatalf("work set exited %d: %v", code, err)
	}
	var claim protocol.WorkClaim
	if err := json.Unmarshal(output.Bytes(), &claim); err != nil {
		t.Fatal(err)
	}
	if claim.Scope != scope.ID || claim.SessionID != "session-1" || claim.SessionFile != file ||
		claim.CWD != "/live-project" || claim.URL != "https://github.com/org/repo/pull/93" ||
		claim.Branch != "issue-93/ownership" || claim.Summary != "--profile work; literal $text" {
		t.Fatalf("unexpected live claim: %+v", claim)
	}
}

func TestWorkSetReplacesTheClaimForTheSameSavedConversation(t *testing.T) {
	scope := isolatedWorkScope(t, "default")
	original := seedWorkClaim(t, scope, workSessionID, "owner.jsonl", workCommandURL)
	registerWorkStatus(t, scope, workCommandID, original.SessionID, original.SessionFile)

	var output bytes.Buffer
	code, err := runWork(&output, []string{
		"set", "abcdef", "https://github.com/org/repo/issues/94", "Review the replacement task",
	})

	if err != nil || code != 0 {
		t.Fatalf("work set exited %d: %v", code, err)
	}
	claims, err := linux.ReadWorkClaims(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || claims[0].URL != "https://github.com/org/repo/issues/94" ||
		claims[0].Summary != "Review the replacement task" || claims[0].UpdatedAt == "2000-01-01T00:00:00Z" {
		t.Fatalf("set did not replace the previous task: %+v", claims)
	}
}

func TestWorkFindReturnsOnlyMatchingConversationAtItsNewLaunch(t *testing.T) {
	scope := isolatedWorkScope(t, "default")
	claim := seedWorkClaim(t, scope, workSessionID, "owner.jsonl", workCommandURL)
	other := seedWorkClaim(t, scope, "session-2", "other.jsonl", "https://github.com/org/repo/pull/94")
	newLaunch := strings.Repeat("b", 32)
	registerWorkStatus(t, scope, newLaunch, claim.SessionID, claim.SessionFile)
	registerWorkStatus(t, scope, workCommandID, other.SessionID, other.SessionFile)

	var output bytes.Buffer
	code, err := runWork(&output, []string{"find", "--json", "https://github.com/ORG/REPO/pull/93"})

	if err != nil || code != 0 {
		t.Fatalf("work find exited %d: %v", code, err)
	}
	var rows []cli.WorkRow
	if err := json.Unmarshal(output.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].SessionID != "session-1" || rows[0].Availability != "online" ||
		!reflect.DeepEqual(rows[0].InstanceIDs, []string{"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}) {
		t.Fatalf("find did not return the matching conversation's current launch: %s", output.String())
	}
}

func TestWorkFindNeverHidesConflictingOfflineOwners(t *testing.T) {
	scope := isolatedWorkScope(t, "default")
	claim := seedWorkClaim(t, scope, workSessionID, "owner.jsonl", workCommandURL)
	seedWorkClaim(t, scope, "session-2", "offline.jsonl", workCommandURL)
	registerWorkStatus(t, scope, workCommandID, claim.SessionID, claim.SessionFile)

	var output bytes.Buffer
	code, err := runWork(&output, []string{"find", workCommandURL})

	if err != nil || code != 0 {
		t.Fatalf("work find exited %d: %v", code, err)
	}
	for _, want := range []string{
		"[online, stale, conflict]", "[offline, stale, conflict]",
		"Live instances: abcdef00000000000000000000000000", "Live instances: none", "updated: 2000-01-01T00:00:00Z",
	} {
		if !strings.Contains(output.String(), want) {
			t.Errorf("find omitted %q:\n%s", want, output.String())
		}
	}
}

func TestWorkClearRetainsOtherSavedFileWithSameSessionID(t *testing.T) {
	scope := isolatedWorkScope(t, "default")
	claim := seedWorkClaim(t, scope, workSessionID, "clear.jsonl", workCommandURL)
	seedWorkClaim(t, scope, workSessionID, "keep.jsonl", workCommandURL)
	registerWorkStatus(t, scope, workCommandID, claim.SessionID, claim.SessionFile)

	var output bytes.Buffer
	code, err := runWork(&output, []string{"clear", "abcdef"})

	if err != nil || code != 0 {
		t.Fatalf("work clear exited %d: %v", code, err)
	}
	claims, err := linux.ReadWorkClaims(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || filepath.Base(claims[0].SessionFile) != "keep.jsonl" {
		t.Fatalf("clear left unexpected claims: %+v", claims)
	}
}

func TestWorkClearRefusesAnInvokingLaunchThatSwitchedSessionFiles(t *testing.T) {
	scope := isolatedWorkScope(t, "default")
	claim := seedWorkClaim(t, scope, workSessionID, "live.jsonl", workCommandURL)
	registerWorkStatus(t, scope, workCommandID, claim.SessionID, claim.SessionFile)
	expectedFile := filepath.Join(scope.AgentDir, "sessions", "former.jsonl")

	var output bytes.Buffer
	code, err := runWork(&output, []string{
		"clear", "--expect-session-id=" + claim.SessionID, "--expect-session-file=" + expectedFile, "--", workCommandID,
	})

	if err == nil || code != 1 || !strings.Contains(err.Error(), "no longer the invoking saved conversation") {
		t.Fatalf("guarded work clear returned (%d, %v)", code, err)
	}
	claims, err := linux.ReadWorkClaims(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 1 || filepath.Base(claims[0].SessionFile) != "live.jsonl" {
		t.Fatalf("failed guard changed the saved claim: %+v", claims)
	}
}

func TestWorkFindWithoutMatchPrintsEmptyJSONArray(t *testing.T) {
	scope := isolatedWorkScope(t, "default")
	seedWorkClaim(t, scope, workSessionID, "owner.jsonl", "https://github.com/org/repo/pull/94")

	var output bytes.Buffer
	code, err := runWork(&output, []string{"find", "--json", workCommandURL})

	if err != nil || code != 0 || output.String() != "[]\n" {
		t.Fatalf("empty work find returned (%d, %v): %q", code, err, output.String())
	}
}

func TestWorkFindWithoutMatchExplainsTheScopedMiss(t *testing.T) {
	isolatedWorkScope(t, "default")

	var output bytes.Buffer
	code, err := runWork(&output, []string{"find", workCommandURL})

	const want = "No work claims for https://github.com/org/repo/pull/93 in this scope.\n"
	if err != nil || code != 0 || output.String() != want {
		t.Fatalf("empty work find returned (%d, %v): %q", code, err, output.String())
	}
}

func TestWorkListDoesNotCreateClaimStorage(t *testing.T) {
	scope := isolatedWorkScope(t, "default")

	var output bytes.Buffer
	code, err := runWork(&output, []string{"list", "--json"})

	if err != nil || code != 0 {
		t.Fatalf("work list exited %d: %v", code, err)
	}
	if _, err := os.Stat(scope.AgentDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("work list touched the absent agent directory: %v", err)
	}
}

func TestWorkListEscapesHumanFacingFreeText(t *testing.T) {
	scope := isolatedWorkScope(t, "default")
	claim := protocol.WorkClaim{
		Version:     protocol.WorkClaimVersion,
		Scope:       scope.ID,
		SessionID:   "session-1",
		SessionFile: filepath.Join(scope.AgentDir, "sessions", "owner.jsonl"),
		CWD:         "/work/project",
		URL:         workCommandURL,
		Summary:     "review \"details\"\u202e",
		Branch:      "issue-93/branch\u202e",
		UpdatedAt:   "2000-01-01T00:00:00Z",
	}
	if err := linux.WriteWorkClaim(scope, claim); err != nil {
		t.Fatal(err)
	}

	var output bytes.Buffer
	code, err := runWork(&output, []string{"list"})

	if err != nil || code != 0 {
		t.Fatalf("work list exited %d: %v", code, err)
	}

	for _, want := range []string{`"review \"details\"\u202e"`, `"issue-93/branch\u202e"`} {
		if !strings.Contains(output.String(), want) {
			t.Errorf("work output did not escape %q: %q", want, output.String())
		}
	}
}

func TestWorkHelpDoesNotRequireTransport(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "invalid-relative-path")

	var output bytes.Buffer
	code, err := runWork(&output, []string{"--help"})

	if err != nil || code != 0 || !strings.HasPrefix(output.String(), "Usage: ompi control work") {
		t.Fatalf("work capability query returned (%d, %v): %q", code, err, output.String())
	}
}

func TestWorkRejectsInvalidInvocationBeforeTransport(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "invalid-relative-path")
	for _, args := range [][]string{
		{"set", "abcdef", workCommandURL, "summary", "--branch", "late"},
		{"set", "abcdef", workCommandURL, "unquoted", "summary"},
		{"set", "abcdef", workCommandURL, ""},
		{"find", workCommandURL + "?extra=true"},
		{"clear"},
		{"clear", "all"},
		{"clear", "--expect-session-id=session-1", workCommandID},
		{"clear", "--expect-session-id=session-1", "--expect-session-file=/sessions/live.jsonl", "abcdef"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			var output bytes.Buffer
			_, err := runWork(&output, args)
			if !errors.Is(err, errUsage) {
				t.Fatalf("invalid work command returned %v, want usage error", err)
			}
		})
	}
}

func isolatedWorkScope(t *testing.T, profile string) protocol.Scope {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "ompi-work-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	t.Setenv("XDG_RUNTIME_DIR", root)
	t.Setenv("HOME", root)
	t.Setenv("OMP_PROFILE", "default")
	t.Setenv("PI_CONFIG_DIR", "")
	t.Setenv("PI_CODING_AGENT_DIR", "")

	scope, err := protocol.GetScope(profile, "")
	if err != nil {
		t.Fatal(err)
	}
	return scope
}

func seedWorkClaim(t *testing.T, scope protocol.Scope, sessionID, name, url string) protocol.WorkClaim {
	t.Helper()
	claim := protocol.WorkClaim{
		Version:     protocol.WorkClaimVersion,
		Scope:       scope.ID,
		SessionID:   sessionID,
		SessionFile: filepath.Join(scope.AgentDir, "sessions", name),
		CWD:         "/live-project",
		URL:         url,
		Summary:     "Implement the ticket",
		UpdatedAt:   "2000-01-01T00:00:00Z",
	}
	if err := linux.WriteWorkClaim(scope, claim); err != nil {
		t.Fatal(err)
	}
	return claim
}

func registerWorkStatus(t *testing.T, scope protocol.Scope, instanceID, sessionID, sessionFile string) {
	t.Helper()
	if _, err := linux.NewTransport(scope); err != nil {
		t.Fatal(err)
	}
	root, err := linux.RuntimeRoot()
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(scope.ID))
	directory := filepath.Join(root, hex.EncodeToString(digest[:])[:16])
	oldFile := filepath.Join(scope.AgentDir, "sessions", "old.jsonl")
	record := protocol.Record{
		Version:         protocol.Version,
		InstanceID:      instanceID,
		Scope:           scope.ID,
		PID:             os.Getpid(),
		CWD:             "/old-project",
		SessionID:       "outdated-session",
		SessionFile:     &oldFile,
		LauncherManaged: true,
		State:           "running",
	}
	if err := linux.WritePrivateJSON(filepath.Join(directory, instanceID+".json"), record); err != nil {
		t.Fatal(err)
	}

	listener, err := net.Listen("unix", filepath.Join(directory, instanceID+".sock"))
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	t.Cleanup(func() {
		_ = listener.Close()
		<-done
	})
	status := protocol.Data{
		Version:         protocol.Version,
		InstanceID:      instanceID,
		Scope:           scope.ID,
		PID:             os.Getpid(),
		CWD:             "/live-project",
		SessionID:       sessionID,
		SessionFile:     &sessionFile,
		LauncherManaged: true,
		State:           "running",
	}
	go func() {
		defer close(done)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			serveWorkStatus(t, connection, &status)
		}
	}()
}

func serveWorkStatus(t *testing.T, connection net.Conn, status *protocol.Data) {
	t.Helper()
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Error(err)
		return
	}
	var request protocol.Request
	if err := json.NewDecoder(connection).Decode(&request); err != nil {
		t.Error(err)
		return
	}
	if request.Action != "status" {
		t.Errorf("work command requested %q instead of status", request.Action)
		return
	}
	response := protocol.Response{
		Version:    protocol.Version,
		InstanceID: request.InstanceID,
		RequestID:  request.RequestID,
		OK:         true,
		Data:       status,
	}
	if err := json.NewEncoder(connection).Encode(response); err != nil {
		t.Error(err)
	}
}
