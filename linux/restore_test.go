package linux

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func TestNewRestoreOwnerIncludesBootAndProcessStartIdentity(t *testing.T) {
	owner, err := NewRestoreOwner(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if owner.PID != os.Getpid() || owner.BootID == "" || owner.StartTime == "" {
		t.Fatalf("NewRestoreOwner() = %#v", owner)
	}
	if err := requireRestoreOwnerStopped(owner); err == nil || !strings.Contains(err.Error(), "still running") {
		t.Fatalf("live owner was not refused: %v", err)
	}
}

func TestRestoreOwnerStartTimeDistinguishesReusedPID(t *testing.T) {
	owner, err := NewRestoreOwner(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if owner.StartTime == "0" {
		owner.StartTime = "1"
	} else {
		owner.StartTime = "0"
	}
	if err := requireRestoreOwnerStopped(owner); err != nil {
		t.Fatalf("a reused PID was treated as the original live launcher: %v", err)
	}
}

func TestSaveRestoreNameIsImmutableAndListsExactSnapshot(t *testing.T) {
	scope, first := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	if err := SaveRestoreName(scope, "work", first.RestoreID); err != nil {
		t.Fatal(err)
	}

	second := first
	second.RestoreID = strings.Repeat("b", 32)
	second.SessionID = "other-session"
	writeRestoreFixtureSnapshot(t, scope, second)
	if err := SaveRestoreName(scope, "work", second.RestoreID); err == nil {
		t.Fatal("saving an existing name unexpectedly retargeted it")
	}

	sessions, err := ListSavedSessions(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].Name != "work" || sessions[0].Session.RestoreID != first.RestoreID {
		t.Fatalf("ListSavedSessions() = %#v", sessions)
	}
	if err := SaveRestoreName(scope, "save", first.RestoreID); err == nil {
		t.Fatal("reserved command name was accepted")
	}
}

func TestSavedNameFollowsItsWrapperSlotToTheCurrentSession(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("8", 32), stoppedRestoreOwner())
	if err := SaveRestoreName(scope, "alpha", session.RestoreID); err != nil {
		t.Fatal(err)
	}

	updated := session
	updated.SessionID = "after-branch-session"
	updated.CWD = filepath.Join(filepath.Dir(session.CWD), "next-worktree")
	if err := os.Mkdir(updated.CWD, 0o700); err != nil {
		t.Fatal(err)
	}
	updated.SessionFile = filepath.Join(filepath.Dir(scope.AgentDir), "after-branch-session.jsonl")
	if err := os.WriteFile(updated.SessionFile, []byte("current persisted session\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	updated.UpdatedAt = time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
	writeRestoreFixtureSnapshot(t, scope, updated)

	sessions, err := ListSavedSessions(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].Name != "alpha" {
		t.Fatalf("ListSavedSessions() = %#v", sessions)
	}
	current := sessions[0].Session
	if current.RestoreID != session.RestoreID || current.SessionID != updated.SessionID ||
		current.SessionFile != updated.SessionFile || current.CWD != updated.CWD {
		t.Fatalf("saved wrapper slot did not follow its current OMP session: %#v", current)
	}
}

func TestRestoreNamedSessionHoldsExactCWDAndNormalizedResumeArguments(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("c", 32), stoppedRestoreOwner())
	session.ResumeArgs = []string{
		"--model=small",
		"--thinking", "high",
		"--system-prompt", "first line\nsecond line",
	}
	session.SessionFile = filepath.Join(filepath.Dir(scope.AgentDir), "external-session.jsonl")
	if err := os.WriteFile(session.SessionFile, []byte("external persisted session\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	writeRestoreFixtureSnapshot(t, scope, session)
	if err := SaveRestoreName(scope, "project", session.RestoreID); err != nil {
		t.Fatal(err)
	}
	previousCWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	launchCalls := 0
	code, err := restoreNamedSession(scope, "project", filepath.Join(t.TempDir(), "extension.js"), true,
		func(args []string, extensionPath, restoreID string, _ *os.File) (int, error) {
			launchCalls++
			directories, dirErr := ensureRestoreDirectories(scope)
			if dirErr != nil {
				t.Fatal(dirErr)
			}
			secondLock, lockErr := lockRestoreSnapshot(directories, session.RestoreID)
			if lockErr == nil {
				closeRestoreLock(secondLock)
				t.Fatal("snapshot lock was released before the foreground launch returned")
			}
			if !strings.Contains(lockErr.Error(), "already in progress") {
				t.Fatalf("unexpected lock result during launch: %v", lockErr)
			}
			currentCWD, cwdErr := os.Getwd()
			if cwdErr != nil {
				t.Fatal(cwdErr)
			}
			if currentCWD != session.CWD {
				t.Fatalf("launch cwd = %q, want saved cwd %q", currentCWD, session.CWD)
			}
			wantArgs := []string{
				"--model=small", "--thinking", "high",
				"--system-prompt", "first line\nsecond line",
				"-r", session.SessionFile,
			}
			if !reflect.DeepEqual(args, wantArgs) {
				t.Fatalf("launch args = %#v, want %#v", args, wantArgs)
			}
			if restoreID != session.RestoreID {
				t.Fatalf("launch restore ID = %q, want %q", restoreID, session.RestoreID)
			}
			if extensionPath != filepath.Join(filepath.Dir(extensionPath), "extension.js") {
				t.Fatalf("unexpected extension path: %q", extensionPath)
			}
			if os.Getenv("PI_CONFIG_DIR") != scope.ConfigRoot || os.Getenv("OMP_PROFILE") != scope.Profile ||
				os.Getenv("PI_CODING_AGENT_DIR") != scope.AgentDir {
				t.Fatal("launch environment did not preserve the saved scope")
			}
			return 17, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if code != 17 || launchCalls != 1 {
		t.Fatalf("restore result = (%d, %v), launcher calls = %d", code, err, launchCalls)
	}
	currentCWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if currentCWD != previousCWD {
		t.Fatalf("process cwd after restore = %q, want %q", currentCWD, previousCWD)
	}
}

func TestRestoreNamedSessionRefusesLiveOwnerWithoutLaunching(t *testing.T) {
	owner, err := NewRestoreOwner(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	scope, session := newRestoreFixture(t, strings.Repeat("d", 32), owner)
	if err := SaveRestoreName(scope, "live", session.RestoreID); err != nil {
		t.Fatal(err)
	}
	launchCalls := 0
	_, err = restoreNamedSession(scope, "live", filepath.Join(t.TempDir(), "extension.js"), true,
		func([]string, string, string, *os.File) (int, error) {
			launchCalls++
			return 0, nil
		})
	if err == nil || !strings.Contains(err.Error(), "still running") {
		t.Fatalf("live launcher owner was not refused: %v", err)
	}
	if launchCalls != 0 {
		t.Fatalf("launcher called %d times for a live owner", launchCalls)
	}
}

func TestRestoreNamedSessionRefusesLiveAgentAfterLauncherStops(t *testing.T) {
	agentOwner, err := NewRestoreOwner(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	scope, session := newRestoreFixture(t, strings.Repeat("7", 32), stoppedRestoreOwner())
	session.AgentOwner = agentOwner
	writeRestoreFixtureSnapshot(t, scope, session)
	if err := SaveRestoreName(scope, "orphan-child", session.RestoreID); err != nil {
		t.Fatal(err)
	}

	launchCalls := 0
	_, err = restoreNamedSession(scope, "orphan-child", filepath.Join(t.TempDir(), "extension.js"), true,
		func([]string, string, string, *os.File) (int, error) {
			launchCalls++
			return 0, nil
		})
	if err == nil || !strings.Contains(err.Error(), "original OMP process") || !strings.Contains(err.Error(), "still running") {
		t.Fatalf("live orphaned OMP child was not refused: %v", err)
	}
	if launchCalls != 0 {
		t.Fatalf("launcher called %d times while an OMP child remained live", launchCalls)
	}
}

func TestRestoreNamedSessionRefusesHeldSnapshotLock(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("e", 32), stoppedRestoreOwner())
	if err := SaveRestoreName(scope, "locked", session.RestoreID); err != nil {
		t.Fatal(err)
	}

	if err := SaveRestoreName(scope, "alias", session.RestoreID); err != nil {
		t.Fatal(err)
	}
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	lock, err := lockRestoreSnapshot(directories, session.RestoreID)
	if err != nil {
		t.Fatal(err)
	}
	defer closeRestoreLock(lock)

	launchCalls := 0
	_, err = restoreNamedSession(scope, "alias", filepath.Join(t.TempDir(), "extension.js"), true,
		func([]string, string, string, *os.File) (int, error) {
			launchCalls++
			return 0, nil
		})
	if err == nil || !strings.Contains(err.Error(), "already in progress") {
		t.Fatalf("held restore lock was not refused: %v", err)
	}
	if launchCalls != 0 {
		t.Fatalf("launcher called %d times while another restore held the lock", launchCalls)
	}
}

func TestRestoreNamedSessionRefusesUncertainOwnerAndNonTerminal(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("f", 32), stoppedRestoreOwner())
	session.Owner.StartTime = "unknown"
	writeRestoreFixtureSnapshot(t, scope, session)
	writeRestoreFixtureName(t, scope, "uncertain", session.RestoreID)

	launchCalls := 0
	_, err := restoreNamedSession(scope, "uncertain", filepath.Join(t.TempDir(), "extension.js"), true,
		func([]string, string, string, *os.File) (int, error) {
			launchCalls++
			return 0, nil
		})
	if err == nil || !strings.Contains(err.Error(), "invalid snapshot owner") {
		t.Fatalf("uncertain owner was not refused: %v", err)
	}
	if launchCalls != 0 {
		t.Fatalf("launcher called %d times for an uncertain owner", launchCalls)
	}

	session.Owner = stoppedRestoreOwner()
	writeRestoreFixtureSnapshot(t, scope, session)
	if err := SaveRestoreName(scope, "terminal", session.RestoreID); err != nil {
		t.Fatal(err)
	}
	_, err = restoreNamedSession(scope, "terminal", filepath.Join(t.TempDir(), "extension.js"), false,
		func([]string, string, string, *os.File) (int, error) {
			launchCalls++
			return 0, nil
		})
	if err == nil || !strings.Contains(err.Error(), "requires an interactive terminal") {
		t.Fatalf("non-terminal restore was not refused: %v", err)
	}
	if launchCalls != 0 {
		t.Fatalf("launcher called %d times without a terminal", launchCalls)
	}
}

func TestListSavedSessionsRejectsCrossScopeSnapshot(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("1", 32), stoppedRestoreOwner())
	if err := SaveRestoreName(scope, "scoped", session.RestoreID); err != nil {
		t.Fatal(err)
	}
	otherScope := scope
	otherScope.Profile = "other"
	writeRestoreFixtureSnapshot(t, scope, protocol.SavedSession{
		Version: 1, RestoreID: session.RestoreID, Scope: otherScope,
		SessionFile: session.SessionFile, SessionID: session.SessionID, CWD: session.CWD,
		ResumeArgs: []string{}, Owner: stoppedRestoreOwner(), AgentOwner: stoppedRestoreOwner(),
		UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if _, err := ListSavedSessions(scope); err == nil || !strings.Contains(err.Error(), "scope does not match") {
		t.Fatalf("cross-scope snapshot was not rejected: %v", err)
	}
	launchCalls := 0
	_, restoreErr := restoreNamedSession(scope, "scoped", filepath.Join(t.TempDir(), "extension.js"), true,
		func([]string, string, string, *os.File) (int, error) {
			launchCalls++
			return 0, nil
		})
	if restoreErr == nil || !strings.Contains(restoreErr.Error(), "scope does not match") {
		t.Fatalf("cross-scope restore was not rejected: %v", restoreErr)
	}
	if launchCalls != 0 {
		t.Fatalf("launcher called %d times for a cross-scope snapshot", launchCalls)
	}

}

func TestSaveAndRestoreRejectMissingAndUnsafeSessionFiles(t *testing.T) {
	scope, session := newRestoreFixture(t, strings.Repeat("2", 32), stoppedRestoreOwner())
	healthy := session
	healthy.RestoreID = strings.Repeat("4", 32)
	healthy.SessionID = "healthy-session"
	healthy.SessionFile = filepath.Join(scope.AgentDir, "sessions", "healthy.jsonl")
	if err := os.WriteFile(healthy.SessionFile, []byte("healthy session\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeRestoreFixtureSnapshot(t, scope, healthy)
	if err := SaveRestoreName(scope, "healthy", healthy.RestoreID); err != nil {
		t.Fatal(err)
	}

	writeRestoreFixtureName(t, scope, "missing", session.RestoreID)
	if err := os.Remove(session.SessionFile); err != nil {
		t.Fatal(err)
	}
	sessions, err := ListSavedSessions(scope)
	if err != nil {
		t.Fatalf("missing session file hid saved names from the menu: %v", err)
	}
	if len(sessions) != 2 || sessions[0].Name != "healthy" || sessions[1].Name != "missing" {
		t.Fatalf("saved names after one transcript disappeared = %#v", sessions)
	}

	if err := SaveRestoreName(scope, "missing-new", session.RestoreID); err == nil {
		t.Fatal("missing session file was accepted when saving a name")
	}
	launchCalls := 0
	_, err = restoreNamedSession(scope, "missing", filepath.Join(t.TempDir(), "extension.js"), true,
		func([]string, string, string, *os.File) (int, error) {
			launchCalls++
			return 0, nil
		})
	if err == nil || !strings.Contains(err.Error(), "missing or unsafe") {
		t.Fatalf("missing session file was accepted for restore: %v", err)
	}
	if launchCalls != 0 {
		t.Fatalf("launcher called %d times for a missing session file", launchCalls)
	}

	scope, session = newRestoreFixture(t, strings.Repeat("3", 32), stoppedRestoreOwner())
	writeRestoreFixtureName(t, scope, "symlink", session.RestoreID)
	if err := os.Remove(session.SessionFile); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(scope.AgentDir, "absent-session"), session.SessionFile); err != nil {
		t.Fatal(err)
	}
	if err := SaveRestoreName(scope, "symlink-new", session.RestoreID); err == nil {
		t.Fatal("symbolic-link session file was accepted when saving a name")
	}
	_, err = restoreNamedSession(scope, "symlink", filepath.Join(t.TempDir(), "extension.js"), true,
		func([]string, string, string, *os.File) (int, error) {
			launchCalls++
			return 0, nil
		})
	if err == nil || !strings.Contains(err.Error(), "missing or unsafe") {
		t.Fatalf("symbolic-link session file was accepted for restore: %v", err)
	}
	if launchCalls != 0 {
		t.Fatalf("launcher called %d times for an unsafe session file", launchCalls)
	}
}

func TestListSavedSessionsDefersMissingWorkingDirectoryValidation(t *testing.T) {
	scope, healthy := newRestoreFixture(t, strings.Repeat("5", 32), stoppedRestoreOwner())
	if err := SaveRestoreName(scope, "healthy", healthy.RestoreID); err != nil {
		t.Fatal(err)
	}

	broken := healthy
	broken.RestoreID = strings.Repeat("6", 32)
	broken.SessionID = "missing-directory-session"
	broken.CWD = filepath.Join(filepath.Dir(healthy.CWD), "missing-project")
	writeRestoreFixtureSnapshot(t, scope, broken)
	writeRestoreFixtureName(t, scope, "missing-cwd", broken.RestoreID)

	sessions, err := ListSavedSessions(scope)
	if err != nil {
		t.Fatalf("missing working directory hid healthy saved names: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("saved names = %#v, want both healthy and missing-cwd entries", sessions)
	}
	launchCalls := 0
	_, err = restoreNamedSession(scope, "missing-cwd", filepath.Join(t.TempDir(), "extension.js"), true,
		func([]string, string, string, *os.File) (int, error) {
			launchCalls++
			return 0, nil
		})
	if err == nil || !strings.Contains(err.Error(), "working directory is missing or unsafe") {
		t.Fatalf("missing working directory was accepted for restore: %v", err)
	}
	if launchCalls != 0 {
		t.Fatalf("launcher called %d times for a missing working directory", launchCalls)
	}
}

func TestMissingSnapshotIsUnavailableUntilCurrentSnapshotReturns(t *testing.T) {
	scope, healthy := newRestoreFixture(t, strings.Repeat("a", 32), stoppedRestoreOwner())
	if err := SaveRestoreName(scope, "healthy", healthy.RestoreID); err != nil {
		t.Fatal(err)
	}
	missingRestoreID := strings.Repeat("9", 32)
	writeRestoreFixtureName(t, scope, "stale", missingRestoreID)

	sessions, err := ListSavedSessions(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 || sessions[0].Name != "healthy" || sessions[1].Name != "stale" {
		t.Fatalf("named sessions with a missing current snapshot = %#v", sessions)
	}
	if sessions[1].Unavailable == "" || sessions[1].Session.RestoreID != "" {
		t.Fatalf("missing snapshot did not produce an unavailable row: %#v", sessions[1])
	}

	launchCalls := 0
	_, err = restoreNamedSession(scope, "stale", filepath.Join(t.TempDir(), "extension.js"), true,
		func([]string, string, string, *os.File) (int, error) {
			launchCalls++
			return 0, nil
		})
	if err == nil || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("restore accepted a name with no current snapshot: %v", err)
	}
	if launchCalls != 0 {
		t.Fatalf("launcher called %d times for an unavailable name", launchCalls)
	}

	current := healthy
	current.RestoreID = missingRestoreID
	current.SessionID = "current-session"
	writeRestoreFixtureSnapshot(t, scope, current)
	sessions, err = ListSavedSessions(scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 || sessions[1].Name != "stale" ||
		sessions[1].Unavailable != "" || sessions[1].Session.RestoreID != missingRestoreID ||
		sessions[1].Session.SessionID != "current-session" {
		t.Fatalf("name did not become available from its current slot snapshot: %#v", sessions)
	}
}
func newRestoreFixture(t *testing.T, restoreID string, owner protocol.RestoreOwner) (protocol.Scope, protocol.SavedSession) {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	agentDir := filepath.Join(root, "agent")
	sessionDirectory := filepath.Join(agentDir, "sessions")
	if err := os.MkdirAll(sessionDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	cwd := filepath.Join(root, "project")
	if err := os.Mkdir(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	sessionFile := filepath.Join(sessionDirectory, "saved.jsonl")
	if err := os.WriteFile(sessionFile, []byte("persisted session\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	scope := protocol.Scope{
		ID: strings.Repeat("a", 16), ConfigRoot: filepath.Join(root, "config"),
		Profile: "default", AgentDir: agentDir,
	}
	if err := os.Mkdir(scope.ConfigRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	session := protocol.SavedSession{
		Version: 1, RestoreID: restoreID, Scope: scope, SessionFile: sessionFile,
		SessionID: "session-fixture", CWD: cwd, ResumeArgs: []string{}, Owner: owner,
		AgentOwner: stoppedRestoreOwner(),
		UpdatedAt:  time.Now().UTC().Format(time.RFC3339Nano),
	}
	writeRestoreFixtureSnapshot(t, scope, session)
	return scope, session
}

func writeRestoreFixtureSnapshot(t *testing.T, scope protocol.Scope, session protocol.SavedSession) {
	t.Helper()
	directory := filepath.Join(scope.AgentDir, "instance-control", "restore", "snapshots")
	if err := EnsurePrivateDirectory(directory); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(directory, session.RestoreID+".json")
	if err := WritePrivateJSON(file, session); err != nil {
		t.Fatal(err)
	}
}

func writeRestoreFixtureName(t *testing.T, scope protocol.Scope, name, restoreID string) {
	t.Helper()
	directories, err := ensureRestoreDirectories(scope)
	if err != nil {
		t.Fatal(err)
	}
	if err := createImmutableRestoreName(directories, name, restoreID); err != nil {
		t.Fatal(err)
	}
}

func stoppedRestoreOwner() protocol.RestoreOwner {
	return protocol.RestoreOwner{
		BootID: "00000000-0000-4000-8000-000000000000", PID: os.Getpid(), StartTime: "1",
	}
}
