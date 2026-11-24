package linux

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	"github.com/klondikemarlen/omp-instance-control/protocol"
)

const (
	restartObservationFilename = "restart-observation.json"
	restartOnlineFilename      = "restart-online.json"
	restartDiagnosticsDir      = "restart-diagnostics-v1"
)

var (
	restartUUIDPattern   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	restartDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type restartObservation struct {
	restartRecord
	Stage      string         `json:"stage"`
	ObservedAt time.Time      `json:"observedAt"`
	ExitCode   *int           `json:"exitCode,omitempty"`
	Signal     syscall.Signal `json:"signal,omitempty"`
	Error      string         `json:"error,omitempty"`
}

// Keep filenames, normalized identities, and snapshot fields in sync with the OMP adapter.
// Only launch scope and validated correlation enter this observer; it never owns launch decisions.
type restartObserver struct {
	scope protocol.Scope
	id    restartRecord
}

func (observer restartObserver) path() string {
	return filepath.Join(observer.scope.AgentDir, "instance-control", restartDiagnosticsDir,
		observer.id.PreviousInstanceID[:2]+".json")
}

func (observer restartObserver) observe(stage, reason string, exitCode *int, signal syscall.Signal) {
	if observer.id.OperationID == "" {
		return
	}
	_ = WritePrivateJSON(observer.path(), restartObservation{
		restartRecord: observer.id,
		Stage:         stage,
		ObservedAt:    time.Now().UTC(),
		ExitCode:      exitCode,
		Signal:        signal,
		Error:         reason,
	})
}

func (observer restartObserver) saw(stages ...string) bool {
	if observer.id.OperationID == "" {
		return false
	}
	var snapshot restartObservation
	if !readRestartJSON(observer.path(), &snapshot) || snapshot.restartRecord != observer.id {
		return false
	}
	for _, stage := range stages {
		if snapshot.Stage == stage {
			return true
		}
	}
	return false
}

func (observer restartObserver) observeChildFailure(stage string, child childResult, runErr error) bool {
	switch {
	case runErr != nil && child.pid == 0:
		observer.observe(stage, "child-start", nil, 0)
	case runErr != nil || !child.reaped:
		observer.observe(stage, "child-wait", nil, 0)
	case child.signal != 0:
		observer.observe(stage, "signal-observed", nil, child.signal)
	case child.code != 0:
		observer.observe(stage, "child-exit", &child.code, 0)
	default:
		return false
	}
	return true
}

func observeRestart(scope protocol.Scope, id restartRecord) restartObserver {
	if scope.ID == "" || !filepath.IsAbs(scope.AgentDir) || !validInstanceID(id.PreviousInstanceID) || id.OperationID == "" {
		return restartObserver{}
	}
	if !restartUUIDPattern.MatchString(id.OperationID) {
		id.OperationID = fmt.Sprintf("%x", sha256.Sum256([]byte(id.OperationID)))
	}
	return restartObserver{scope: scope, id: id}
}

func readRestartMarker(path string) restartRecord {
	var id restartRecord
	if !readRestartJSON(path, &id) || !validInstanceID(id.PreviousInstanceID) ||
		(!restartUUIDPattern.MatchString(id.OperationID) && !restartDigestPattern.MatchString(id.OperationID)) {
		return restartRecord{}
	}
	return id
}

func readRestartJSON(path string, value any) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() <= 1024 &&
		EnsurePrivateDirectory(filepath.Dir(path)) == nil && ReadPrivateJSON(path, value) == nil
}

func clearRestartMarker(path string) bool {
	err := os.Remove(path)
	return err == nil || errors.Is(err, os.ErrNotExist)
}
