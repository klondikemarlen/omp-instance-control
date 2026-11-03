package linux

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

func failedRestartFixture(t *testing.T) (string, failedRestartRecord) {
	t.Helper()
	scope, session := newRestoreFixture(t, strings.Repeat("b", 32), stoppedRestoreOwner())
	t.Setenv("PI_CONFIG_DIR", scope.ConfigRoot)
	t.Setenv("PI_CODING_AGENT_DIR", scope.AgentDir)
	t.Setenv("OMP_PROFILE", "default")
	var err error
	scope, err = protocol.GetScope("work", session.CWD)
	if err != nil {
		t.Fatal(err)
	}
	session.Scope = scope
	session.ResumeArgs = []string{"--profile=work", "--config=" + filepath.Join(session.CWD, "settings.json"), "--no-tools"}
	if err := os.WriteFile(session.SessionFile, []byte("{\"type\":\"session\",\"id\":\"session-fixture\"}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	writeRestoreFixtureSnapshot(t, scope, session)
	file, err := preserveRestartRecovery(scope, session.RestoreID, session.ResumeArgs, handoffRecord{
		Version: 1, InstanceID: strings.Repeat("c", 32), OperationID: "operation/with unsafe filename characters",
		SessionFile: session.SessionFile, CWD: session.CWD, RestartWrapper: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	record, err := readFailedRestart(file)
	if err != nil {
		t.Fatal(err)
	}
	return file, record
}

func TestFailedRestartRecoveryPreservesExactScopeArgumentsAndLock(t *testing.T) {
	file, expected := failedRestartFixture(t)
	beforeCWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	beforeProfile := os.Getenv("OMP_PROFILE")
	code, err := recoverFailedRestart(file, true, func(actual failedRestartRecord, lock *os.File) (int, error) {
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("manual recovery changed the selected handoff: got=%#v want=%#v", actual, expected)
		}
		cwd, err := os.Getwd()
		if err != nil || cwd != expected.Session.CWD || os.Getenv("OMP_PROFILE") != "work" || os.Getenv("PI_CONFIG_DIR") != expected.Session.Scope.ConfigRoot {
			t.Fatalf("recovery did not anchor the original directory and profile: cwd=%q err=%v", cwd, err)
		}
		directories, err := ensureRestoreDirectories(expected.Session.Scope)
		if err != nil {
			t.Fatal(err)
		}
		other, err := lockRestoreSnapshot(directories, expected.Session.RestoreID)
		if err == nil {
			other.Close()
			t.Fatal("recovery launched without holding its slot lock")
		}
		if lock == nil || !strings.Contains(err.Error(), "already in progress") {
			t.Fatalf("unexpected concurrent recovery result: %v", err)
		}
		return 0, nil
	})
	if err != nil || code != 0 {
		t.Fatalf("manual recovery failed: code=%d err=%v", code, err)
	}
	afterCWD, err := os.Getwd()
	if err != nil || afterCWD != beforeCWD || os.Getenv("OMP_PROFILE") != beforeProfile {
		t.Fatalf("recovery leaked cwd/profile into its caller: cwd=%q err=%v", afterCWD, err)
	}
	if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("completed recovery remained replayable: %v", err)
	}
}

func TestFailedRestartRecoveryRejectsChangedUnavailableOrActiveTarget(t *testing.T) {
	for _, condition := range []string{"missing transcript", "replaced transcript", "changed session ID", "replaced cwd", "missing cwd", "changed slot", "live owner", "unsafe record", "no terminal"} {
		t.Run(condition, func(t *testing.T) {
			file, record := failedRestartFixture(t)
			session := record.Session
			var err error
			switch condition {
			case "missing transcript":
				err = os.Remove(session.SessionFile)
			case "replaced transcript":
				err = os.Rename(session.SessionFile, session.SessionFile+".original")
				if err == nil {
					err = os.WriteFile(session.SessionFile, []byte("{\"type\":\"session\",\"id\":\"session-fixture\"}\n"), 0600)
				}
			case "changed session ID":
				err = os.WriteFile(session.SessionFile, []byte("{\"type\":\"session\",\"id\":\"different-session\"}\n"), 0600)
			case "replaced cwd":
				err = os.Rename(session.CWD, session.CWD+".original")
				if err == nil {
					err = os.Mkdir(session.CWD, 0700)
				}
			case "missing cwd":
				err = os.Remove(session.CWD)
			case "changed slot":
				session.SessionID = "a-newer-conversation"
				writeRestoreFixtureSnapshot(t, session.Scope, session)
			case "live owner":
				record.Session.Owner, err = NewRestoreOwner(os.Getpid())
				if err == nil {
					err = WritePrivateJSON(file, record)
				}
			case "unsafe record":
				err = os.Chmod(file, 0644)
			}
			if err != nil {
				t.Fatal(err)
			}
			called := false
			code, err := recoverFailedRestart(file, condition != "no terminal", func(failedRestartRecord, *os.File) (int, error) {
				called = true
				return 0, nil
			})
			if err == nil || code != 1 || called {
				t.Fatalf("unsafe target reached launch: code=%d err=%v launched=%v", code, err, called)
			}
			if _, err := os.Stat(file); err != nil {
				t.Fatalf("refusal discarded recovery evidence: %v", err)
			}
		})
	}
}

func TestReplacementStartupFailurePreservesOriginalErrorAndExactRecovery(t *testing.T) {
	file, record := failedRestartFixture(t)
	runtime := t.TempDir()
	if err := os.Chmod(runtime, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_RUNTIME_DIR", runtime)
	t.Setenv(ompExecutableEnv, filepath.Join(runtime, "missing-omp"))
	adapter := filepath.Join(runtime, "adapter.js")
	if err := os.WriteFile(adapter, []byte("export default () => {}"), 0600); err != nil {
		t.Fatal(err)
	}
	beforeIn, beforeOut := stdinIsTerminal, stdoutIsTerminal
	stdinIsTerminal = func() bool { return true }
	stdoutIsTerminal = func() bool { return true }
	t.Cleanup(func() { stdinIsTerminal, stdoutIsTerminal = beforeIn, beforeOut })
	code, err := launchWithResume(record.Session.ResumeArgs, adapter, "test", record.Session.RestoreID, nil,
		&resumeState{cwd: record.Session.CWD, sessionFile: record.Session.SessionFile, restart: record.Restart, recoveryFile: file})
	if code != 1 || err == nil || !strings.Contains(err.Error(), "missing-omp") || !strings.Contains(err.Error(), "ompi control recover") {
		t.Fatalf("startup failure lost original error or recovery path: code=%d err=%v", code, err)
	}
	preserved, err := readFailedRestart(file)
	if err != nil || !strings.Contains(preserved.Failure, "missing-omp") || !reflect.DeepEqual(preserved.Session, record.Session) || preserved.Restart != record.Restart {
		t.Fatalf("startup failure discarded exact recovery evidence: record=%#v err=%v", preserved, err)
	}
}

func TestFailedRecoveryAttemptKeepsTheOriginalLaunchFailure(t *testing.T) {
	file, record := failedRestartFixture(t)
	original := errors.New("native execution denied")
	first := restartRecoveryFailure(file, original)
	if !errors.Is(first, original) {
		t.Fatalf("original execution error lost its cause: %v", first)
	}
	attempt := errors.New("replacement OMP exited with status 73")
	second := restartRecoveryFailure(file, attempt)
	if !errors.Is(second, attempt) {
		t.Fatalf("current recovery error lost its cause: %v", second)
	}
	preserved, err := readFailedRestart(file)
	if err != nil || preserved.Failure != original.Error() || preserved.Restart != record.Restart {
		t.Fatalf("a failed recovery replaced the original failure: record=%#v err=%v", preserved, err)
	}
}

func TestConsumedOrChangedRecoveryRecordCannotAcquireLaunchAuthority(t *testing.T) {
	for _, condition := range []string{"consumed", "changed"} {
		t.Run(condition, func(t *testing.T) {
			file, expected := failedRestartFixture(t)
			directories, err := ensureRestoreDirectories(expected.Session.Scope)
			if err != nil {
				t.Fatal(err)
			}
			if condition == "consumed" {
				err = os.Remove(file)
			} else {
				changed := expected
				changed.Session.ResumeArgs = append([]string{"--no-skills"}, expected.Session.ResumeArgs...)
				err = WritePrivateJSON(file, changed)
			}
			if err != nil {
				t.Fatal(err)
			}
			lock, err := lockFailedRestartRecord(file, expected, directories)
			if err == nil || lock != nil {
				if lock != nil {
					lock.Close()
				}
				t.Fatalf("stale record acquired launch authority: condition=%s err=%v", condition, err)
			}
			freshLock, err := lockRestoreSnapshot(directories, expected.Session.RestoreID)
			if err != nil {
				t.Fatalf("record refusal leaked its slot lock: %v", err)
			}
			freshLock.Close()
		})
	}
}

func TestNextRecoveryCaptureFailureRetainsThePrecedingRecordAndStopsRelaunch(t *testing.T) {
	file, record := failedRestartFixture(t)
	root := t.TempDir()
	logPath := filepath.Join(root, "invocations.jsonl")
	prepareFakeOMP(t, root, logPath, record.Session.SessionFile, record.Session.CWD, "valid")
	t.Setenv("PI_CONFIG_DIR", record.Session.Scope.ConfigRoot)
	t.Setenv("PI_CODING_AGENT_DIR", record.Session.Scope.AgentDir)

	// A directory at the next record path forces atomic record replacement to fail.
	nextFile := failedRestartPath(record.Session.Scope, "operation-123")
	if err := os.Mkdir(nextFile, 0700); err != nil {
		t.Fatal(err)
	}

	code, launchError := launchWithResume(record.Session.ResumeArgs, filepath.Join(root, "adapter.js"), "test", record.Session.RestoreID, nil,
		&resumeState{cwd: record.Session.CWD, sessionFile: record.Session.SessionFile, restart: record.Restart, recoveryFile: file})

	preserved, err := readFailedRestart(file)
	if err != nil || !reflect.DeepEqual(preserved.Session, record.Session) || preserved.Restart != record.Restart {
		t.Fatalf("next capture failure discarded the preceding recovery record: record=%#v err=%v", preserved, err)
	}
	if code != 1 || launchError == nil || !strings.Contains(launchError.Error(), "preserve next restart recovery record") {
		t.Fatalf("next capture failure did not explicitly stop relaunch: code=%d err=%v", code, launchError)
	}
	if calls := readInvocations(t, logPath); len(calls) != 1 {
		t.Fatalf("next capture failure launched a replacement: %#v", calls)
	}
}
