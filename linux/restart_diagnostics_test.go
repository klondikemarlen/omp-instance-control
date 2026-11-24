package linux

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const (
	fakeRestartDigest    = "812c5ddd41d2ff22a28394c26e2d39f85520e7a275ec93d815fb536319c7e175"
	fakePreviousInstance = "00000000000000000000000000000001"
	collidingInstance    = "00000000000000000000000000000002"
	fakeCollidingRestart = "aaaaaaaa-0000-4000-8000-000000000002"
)

func TestLaunchRecordsRestartFailureWithoutChangingOutcome(t *testing.T) {
	for _, test := range []struct {
		mode         string
		handoff      string
		code         int
		stage        string
		reason       string
		status       string
		statusNumber int
		wantsErr     bool
	}{
		{
			mode:         "original-exit",
			code:         137,
			stage:        "original-child-failed",
			reason:       "child-exit",
			status:       "exitCode",
			statusNumber: 137,
		},
		{
			mode:         "original-signal",
			code:         128 + int(syscall.SIGKILL),
			stage:        "original-child-failed",
			reason:       "signal-observed",
			status:       "signal",
			statusNumber: int(syscall.SIGKILL),
		},
		{
			mode:   "missing-handoff",
			stage:  "handoff-invalid",
			reason: "handoff-missing",
			status: "exitCode",
		},
		{
			mode:     "invalid-handoff",
			handoff:  "invalid",
			code:     1,
			stage:    "handoff-invalid",
			reason:   "handoff-read",
			status:   "exitCode",
			wantsErr: true,
		},
		{
			mode:     "replacement-start-error",
			handoff:  "valid",
			code:     1,
			stage:    "replacement-failed",
			reason:   "child-start",
			wantsErr: true,
		},
		{
			mode:    "replacement-before-online",
			handoff: "valid",
			stage:   "replacement-exited",
			status:  "exitCode",
		},
	} {
		t.Run(test.mode, func(t *testing.T) {
			root, snapshot := prepareDiagnosticsLaunch(t, test.mode, test.handoff)
			code, err := Launch(nil, filepath.Join(root, "adapter.js"), "test")
			if code != test.code || (err != nil) != test.wantsErr {
				t.Fatalf("launch outcome = (%d, %v)", code, err)
			}
			observed := assertRestartSnapshot(t, snapshot, test.stage, test.reason, test.status)
			if observed["operationId"] != fakeRestartDigest || observed["previousInstanceId"] != fakePreviousInstance {
				t.Fatalf("unexpected restart identity: %#v", observed)
			}
			if test.status != "" && observed[test.status] != float64(test.statusNumber) {
				t.Fatalf("%s = %v, want %d", test.status, observed[test.status], test.statusNumber)
			}
		})
	}
}

func TestLaunchKeepsOnlineEvidenceAfterLaterFailureAndBucketCollision(t *testing.T) {
	root, snapshot := prepareDiagnosticsLaunch(t, "online-collision", "valid")
	code, err := Launch(nil, filepath.Join(root, "adapter.js"), "test")
	if code != 19 || err != nil {
		t.Fatalf("launch outcome = (%d, %v)", code, err)
	}

	observed := assertRestartSnapshot(t, snapshot, "shutdown-requested", "", "")
	if observed["operationId"] != fakeCollidingRestart || observed["previousInstanceId"] != collidingInstance {
		t.Fatalf("later exit overwrote a newer observation: %#v", observed)
	}
}

func TestSuppressedRestartDoesNotBecomeMissingHandoff(t *testing.T) {
	root, snapshot := prepareDiagnosticsLaunch(t, "restart-suppressed", "")
	code, err := Launch(nil, filepath.Join(root, "adapter.js"), "test")
	if code != 0 || err != nil {
		t.Fatalf("launch outcome = (%d, %v)", code, err)
	}
	assertRestartSnapshot(t, snapshot, "restart-suppressed", "", "")
}

func TestLaunchRejectsMarkerThatIsNotPrivate(t *testing.T) {
	root, snapshot := prepareDiagnosticsLaunch(t, "public-marker", "")
	code, err := Launch(nil, filepath.Join(root, "adapter.js"), "test")
	if code != 137 || err != nil {
		t.Fatalf("launch outcome = (%d, %v)", code, err)
	}
	if _, err := os.Stat(snapshot); !os.IsNotExist(err) {
		t.Fatalf("invalid marker selected a snapshot: %v", err)
	}
}

func TestLaunchRetainsOutcomeWhenDiagnosticWriteFails(t *testing.T) {
	root, snapshot := prepareDiagnosticsLaunch(t, "original-exit", "")
	// A directory at the slot path refuses the atomic private file write.
	if err := EnsurePrivateDirectory(snapshot); err != nil {
		t.Fatal(err)
	}
	code, err := Launch(nil, filepath.Join(root, "adapter.js"), "test")
	if code != 137 || err != nil {
		t.Fatalf("diagnostic failure changed launch outcome = (%d, %v)", code, err)
	}
}

func TestLaunchRecordsFailedNativeExec(t *testing.T) {
	root, snapshot := prepareDiagnosticsLaunch(t, "wrapper-exec", "valid")
	t.Setenv("OMPI_TEST_RESTART_WRAPPER", "1")
	originalExec := execWrapperProcess
	execWrapperProcess = func(string, []string, []string) error {
		assertRestartSnapshot(t, snapshot, "replacement-starting", "", "")
		return syscall.EACCES
	}
	t.Cleanup(func() { execWrapperProcess = originalExec })

	code, err := Launch(nil, filepath.Join(root, "adapter.js"), "test")
	if code != 1 || err == nil {
		t.Fatalf("launch outcome = (%d, %v)", code, err)
	}
	assertRestartSnapshot(t, snapshot, "replacement-failed", "wrapper-exec", "")
}

func TestNativeExecStateContinuesRestartObservation(t *testing.T) {
	for _, condition := range []string{"missing-transcript", "missing-omp"} {
		t.Run(condition, func(t *testing.T) {
			root, snapshot := prepareDiagnosticsLaunch(t, "", "")
			scope, err := protocol.GetScope("default", root)
			if err != nil {
				t.Fatal(err)
			}
			token := strings.Repeat("a", 32)
			launchDir := filepath.Join(root, "omp-instance-control", "launch-"+token)
			statePath := filepath.Join(launchDir, execStateFilename)
			state := wrapperExecState{
				Version:     1,
				Args:        []string{"--profile=default"},
				Token:       token,
				Scope:       scope,
				CWD:         root,
				SessionFile: filepath.Join(root, "private-session.jsonl"),
				Restart: restartRecord{
					OperationID:        "operation-123",
					PreviousInstanceID: fakePreviousInstance,
				},
			}
			reason := "child-start"
			if condition == "missing-transcript" {
				state.SessionFile = filepath.Join(root, "missing-session.jsonl")
				reason = "wrapper-state"
			}
			if err := WritePrivateJSON(statePath, state); err != nil {
				t.Fatal(err)
			}
			t.Setenv(execStatePathEnv, statePath)
			t.Setenv(execStateTokenEnv, token)
			t.Setenv(execStateLockEnv, "0")
			t.Setenv(ompExecutableEnv, filepath.Join(root, "missing-omp"))

			code, err := Launch(nil, filepath.Join(root, "adapter.js"), "test")
			if code != 1 || err == nil {
				t.Fatalf("launch outcome = (%d, %v)", code, err)
			}
			observed := assertRestartSnapshot(t, snapshot, "replacement-failed", reason, "")
			if observed["operationId"] != fakeRestartDigest || observed["previousInstanceId"] != fakePreviousInstance {
				t.Fatalf("native wrapper lost restart identity: %#v", observed)
			}
		})
	}
}

func prepareDiagnosticsLaunch(t *testing.T, mode, handoff string) (string, string) {
	t.Helper()
	root := t.TempDir()
	session := filepath.Join(root, "private-session.jsonl")
	if err := os.WriteFile(session, []byte("private session"), 0600); err != nil {
		t.Fatal(err)
	}
	prepareFakeOMP(t, root, filepath.Join(root, "invocations.jsonl"), session, root, handoff)
	t.Setenv("OMPI_TEST_RESTART_DIAGNOSTICS", mode)
	return root, filepath.Join(root, "config", "agent", "instance-control", "restart-diagnostics-v1", "00.json")
}

func assertRestartSnapshot(t *testing.T, path, stage, reason, status string) map[string]any {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("snapshot mode = %v", info.Mode())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var observed map[string]any
	if err := json.Unmarshal(data, &observed); err != nil {
		t.Fatal(err)
	}
	if observed["stage"] != stage {
		t.Fatalf("unexpected stage, want %q: %s", stage, data)
	}
	expectedFields := 4
	if reason != "" {
		expectedFields++
		if observed["error"] != reason {
			t.Fatalf("unexpected error category, want %q: %s", reason, data)
		}
	}
	if status != "" {
		expectedFields++
	}
	if len(observed) != expectedFields {
		t.Fatalf("unexpected snapshot fields: %s", data)
	}
	stamp, ok := observed["observedAt"].(string)
	if !ok || !strings.HasSuffix(stamp, "Z") {
		t.Fatalf("observation time is not UTC: %v", observed["observedAt"])
	}
	if _, err := time.Parse(time.RFC3339, stamp); err != nil {
		t.Fatalf("observation time is not RFC3339: %v", err)
	}
	return observed
}

func fakeRestartDiagnostics(t *testing.T, launchDir, agentDir string, call int, mode string) {
	t.Helper()
	id := restartRecord{
		OperationID:        fakeRestartDigest,
		PreviousInstanceID: fakePreviousInstance,
	}
	snapshot := filepath.Join(agentDir, "instance-control", "restart-diagnostics-v1", "00.json")
	if call == 1 {
		path := filepath.Join(launchDir, "restart-observation.json")
		if err := WritePrivateJSON(path, id); err != nil {
			t.Fatal(err)
		}
		switch mode {
		case "restart-suppressed":
			if err := WritePrivateJSON(snapshot, restartObservation{
				restartRecord: id,
				Stage:         "restart-suppressed",
				ObservedAt:    time.Now().UTC(),
			}); err != nil {
				t.Fatal(err)
			}
		case "public-marker":
			if err := os.Chmod(path, 0644); err != nil {
				t.Fatal(err)
			}
			fallthrough
		case "original-exit":
			os.Exit(137)
		case "original-signal":
			if err := syscall.Kill(os.Getpid(), syscall.SIGKILL); err != nil {
				t.Fatal(err)
			}
		case "replacement-start-error":
			if err := os.Remove(os.Getenv(ompExecutableEnv)); err != nil {
				t.Fatal(err)
			}
		}
		return
	}
	if mode != "online-collision" {
		return
	}
	if err := WritePrivateJSON(filepath.Join(launchDir, "restart-online.json"), id); err != nil {
		t.Fatal(err)
	}
	// Another instance's observation displaced the online snapshot in this slot.
	other := restartObservation{
		restartRecord: restartRecord{
			OperationID:        fakeCollidingRestart,
			PreviousInstanceID: collidingInstance,
		},
		Stage:      "shutdown-requested",
		ObservedAt: time.Now().UTC(),
	}
	if err := WritePrivateJSON(snapshot, other); err != nil {
		t.Fatal(err)
	}
	os.Exit(19)
}
